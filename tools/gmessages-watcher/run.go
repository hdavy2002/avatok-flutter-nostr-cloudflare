package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

const (
	catchUpWindow    = 48 * time.Hour
	catchUpMsgCount  = 50
	catchUpConvCount = 100
	heartbeatEvery   = 5 * time.Minute
	periodicCatchUp  = 15 * time.Minute
)

type Watcher struct {
	cfg      *Config
	log      zerolog.Logger
	sess     *Session
	cli      *libgm.Client
	senderRe *regexp.Regexp
	q        *Queue
	seen     *Seen
	httpc    *http.Client

	convMu sync.Mutex
	convs  map[string]*gmproto.Conversation

	procMu  sync.Mutex // serialises check-and-enqueue between live + catch-up
	msgCh   chan *gmproto.Message
	catchCh chan string

	// health flags (heartbeat is only sent while all are true)
	connected  atomic.Bool
	listenOK   atomic.Bool
	phoneOK    atomic.Bool
	browserOK  atomic.Bool
	loggedOut  atomic.Bool
	logoutOnce sync.Once

	ctx context.Context
}

func newWatcher(cfg *Config, log zerolog.Logger, sess *Session) (*Watcher, error) {
	re, err := regexp.Compile(cfg.SenderRegex)
	if err != nil {
		return nil, fmt.Errorf("bad GMWATCH_SENDER_REGEX: %w", err)
	}
	q, err := LoadQueue(filepath.Join(cfg.DataDir, "queue.json"), filepath.Join(cfg.DataDir, "dead-letter.jsonl"))
	if err != nil {
		return nil, fmt.Errorf("load queue: %w", err)
	}
	w := &Watcher{
		cfg: cfg, log: log, sess: sess, senderRe: re, q: q,
		seen:    LoadSeen(filepath.Join(cfg.DataDir, "seen.json")),
		httpc:   &http.Client{Timeout: 20 * time.Second},
		convs:   map[string]*gmproto.Conversation{},
		msgCh:   make(chan *gmproto.Message, 256),
		catchCh: make(chan string, 1),
	}
	w.listenOK.Store(true)
	w.phoneOK.Store(true)
	w.browserOK.Store(true)
	return w, nil
}

func cmdRun() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	if err := cfg.RequireSigning(); err != nil {
		return err
	}
	sess, err := LoadSession(cfg.DataDir)
	if err != nil {
		return err
	}
	log := newLogger(cfg.Debug)
	w, err := newWatcher(cfg, log, sess)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	w.ctx = ctx

	log.Info().Str("device_id", cfg.DeviceID).Str("webhook", cfg.WebhookURL).Str("heartbeat", cfg.HeartbeatURL).
		Str("sender_regex", cfg.SenderRegex).Str("google_account", sess.Email).Int("queued", w.q.Len()).Msg("gmwatch starting")

	go w.drainLoop(ctx)
	go w.heartbeatLoop(ctx)
	go w.msgWorker(ctx)
	go w.catchUpLoop(ctx)

	backoffN := 0
	for ctx.Err() == nil {
		err := w.connect(ctx)
		if err == nil {
			break
		}
		if w.loggedOut.Load() {
			break
		}
		backoffN++
		d := backoff(backoffN)
		log.Error().Err(err).Dur("retry_in", d).Msg("connect to Google Messages failed")
		select {
		case <-ctx.Done():
		case <-time.After(d):
		}
	}
	<-ctx.Done()
	log.Info().Msg("shutting down")
	if w.cli != nil {
		w.cli.Disconnect()
	}
	if err := sess.Save(cfg.DataDir); err != nil {
		log.Error().Err(err).Msg("saving session on shutdown failed")
	}
	return nil
}

func (w *Watcher) connect(ctx context.Context) error {
	if w.cli == nil {
		w.cli = libgm.NewClient(w.sess.Auth, nil, w.log.With().Str("component", "libgm").Logger(), exhttp.SensibleClientSettings)
		w.cli.SetEventHandler(w.onEvent)
	}
	if err := w.cli.FetchConfig(ctx); err != nil {
		w.log.Warn().Err(err).Msg("FetchConfig failed (continuing, as the bridge does)")
	} else if w.cli.Config.GetDeviceInfo().GetEmail() == "" {
		w.markLoggedOut("Google returned no account e-mail for the saved cookies")
		return errors.New("logged out")
	}
	if err := w.cli.Connect(ctx); err != nil {
		if errors.Is(err, events.ErrRequestedEntityNotFound) {
			w.markLoggedOut("phone unpaired us (404 entity not found)")
		} else if errors.Is(err, events.ErrInvalidCredentials) {
			w.markLoggedOut("Google rejected the saved credentials (invalid authentication)")
		}
		return err
	}
	w.connected.Store(true)
	w.log.Info().Msg("connected to Google Messages (long-poll running)")
	w.triggerCatchUp("initial")
	return nil
}

// ---- events (called synchronously by libgm: must never block) ---------------

func (w *Watcher) onEvent(raw any) {
	switch evt := raw.(type) {
	case *libgm.WrappedMessage:
		select {
		case w.msgCh <- evt.Message:
		default:
			w.log.Error().Msg("message channel full; relying on catch-up")
			w.triggerCatchUp("channel-full")
		}
	case *gmproto.Conversation:
		w.convMu.Lock()
		w.convs[evt.GetConversationID()] = evt
		w.convMu.Unlock()
	case *events.ListenFatalError:
		if errors.Is(evt.Error, events.ErrInvalidCredentials) || strings.Contains(evt.Error.Error(), "401") {
			w.markLoggedOut("long-poll fatal error: " + evt.Error.Error())
		} else {
			w.log.Error().Err(evt.Error).Msg("!!! FATAL LISTEN ERROR - libgm gave up; exiting so launchd restarts us")
			w.listenOK.Store(false)
			go func() { time.Sleep(3 * time.Second); os.Exit(1) }()
		}
	case *events.ListenTemporaryError:
		w.listenOK.Store(false)
		w.log.Warn().Err(evt.Error).Msg("DISCONNECTED: temporary long-poll error (libgm is retrying); heartbeats paused")
	case *events.ListenRecovered:
		w.listenOK.Store(true)
		w.log.Info().Msg("RECONNECTED: long-poll recovered")
		w.triggerCatchUp("listen-recovered")
	case *events.PhoneNotResponding:
		w.phoneOK.Store(false)
		w.log.Error().Msg("!!! PHONE NOT RESPONDING (offline / battery-restricted / Messages app killed); heartbeats paused")
	case *events.PhoneRespondingAgain:
		w.phoneOK.Store(true)
		w.log.Info().Msg("phone responding again")
		w.triggerCatchUp("phone-back")
	case *events.PingFailed:
		if errors.Is(evt.Error, events.ErrRequestedEntityNotFound) {
			w.markLoggedOut("ping says we are no longer paired (404)")
		} else {
			w.log.Warn().Err(evt.Error).Int("count", evt.ErrorCount).Msg("ping to phone failed")
		}
	case *gmproto.RevokePairData:
		w.markLoggedOut("pairing was revoked (unpaired from the phone's Google Messages settings)")
	case *events.GaiaLoggedOut:
		w.markLoggedOut("Google account logged out of Messages for web")
	case *events.AuthTokenRefreshed:
		go func() {
			if err := w.sess.Save(w.cfg.DataDir); err != nil {
				w.log.Error().Err(err).Msg("could not save refreshed session")
			}
		}()
	case *events.NoDataReceived:
		w.log.Warn().Msg("no data received from phone for a while; running catch-up")
		w.triggerCatchUp("no-data")
	case *gmproto.UserAlertEvent:
		w.onAlert(evt)
	default:
		w.log.Debug().Type("event", raw).Msg("unhandled libgm event")
	}
}

func (w *Watcher) onAlert(a *gmproto.UserAlertEvent) {
	switch a.GetAlertType() {
	case gmproto.AlertType_BROWSER_INACTIVE:
		if w.browserOK.Swap(false) {
			w.log.Error().Msg("!!! BROWSER_INACTIVE: another Messages-for-web session took over (did someone open messages.google.com on this Google account?). Trying to reclaim; heartbeats paused")
			go w.reclaimLoop()
		}
	case gmproto.AlertType_BROWSER_ACTIVE:
		w.browserOK.Store(true)
		w.log.Info().Msg("browser session active")
		w.triggerCatchUp("browser-active")
	case gmproto.AlertType_MOBILE_BATTERY_LOW:
		w.log.Warn().Msg("phone battery is LOW - plug it in")
	default:
		w.log.Debug().Str("alert", a.GetAlertType().String()).Msg("user alert")
	}
}

func (w *Watcher) reclaimLoop() {
	for !w.browserOK.Load() && !w.loggedOut.Load() && w.ctx.Err() == nil {
		select {
		case <-w.ctx.Done():
			return
		case <-time.After(60 * time.Second):
		}
		if w.browserOK.Load() {
			return
		}
		w.log.Warn().Msg("reclaiming active web session (SetActiveSession)")
		if err := w.cli.SetActiveSession(w.ctx); err != nil {
			w.log.Error().Err(err).Msg("SetActiveSession failed")
		}
	}
}

func (w *Watcher) markLoggedOut(reason string) {
	w.loggedOut.Store(true)
	w.logoutOnce.Do(func() {
		go func() {
			if w.cli != nil {
				w.cli.Disconnect()
			}
			for w.ctx == nil || w.ctx.Err() == nil {
				w.log.Error().Str("reason", reason).Msg("!!!!! LOGGED OUT / UNPAIRED - NO SMS ARE BEING WATCHED. Run `gmwatch login` again, then restart the service. Heartbeats stopped so the server will alert the owner.")
				select {
				case <-w.ctx.Done():
					return
				case <-time.After(5 * time.Minute):
				}
			}
		}()
	})
}

func (w *Watcher) healthReason() string {
	switch {
	case w.loggedOut.Load():
		return "logged out"
	case !w.connected.Load():
		return "not connected yet"
	case !w.listenOK.Load():
		return "long-poll disconnected"
	case !w.phoneOK.Load():
		return "phone not responding"
	case !w.browserOK.Load():
		return "web session inactive"
	}
	return ""
}

func (w *Watcher) triggerCatchUp(reason string) {
	select {
	case w.catchCh <- reason:
	default:
	}
}

// ---- message handling -------------------------------------------------------

func (w *Watcher) msgWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case m := <-w.msgCh:
			w.handleMessage(ctx, m, nil, "live")
		}
	}
}

func messageText(m *gmproto.Message) string {
	var parts []string
	for _, mi := range m.GetMessageInfo() {
		if c := mi.GetMessageContent().GetContent(); c != "" {
			parts = append(parts, c)
		}
	}
	return strings.Join(parts, "\n")
}

func nonEmpty(dst []string, vals ...string) []string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			dst = append(dst, v)
		}
	}
	return dst
}

func participantLabels(p *gmproto.Participant) []string {
	return nonEmpty(nil, p.GetID().GetNumber(), p.GetFullName(), p.GetFirstName(), p.GetFormattedNumber())
}

// senderCandidates collects every string libgm gives us that could identify the sender.
func senderCandidates(conv *gmproto.Conversation, m *gmproto.Message) []string {
	var c []string
	if conv != nil {
		c = nonEmpty(c, conv.GetName())
		for _, p := range conv.GetParticipants() {
			if p.GetIsMe() {
				continue
			}
			if !conv.GetIsGroupChat() || (m != nil && p.GetID().GetParticipantID() == m.GetParticipantID()) {
				c = append(c, participantLabels(p)...)
			}
		}
	}
	if m != nil && m.GetSenderParticipant() != nil && !m.GetSenderParticipant().GetIsMe() {
		c = append(c, participantLabels(m.GetSenderParticipant())...)
	}
	return c
}

func (w *Watcher) matchesSender(cands []string) bool {
	for _, s := range cands {
		if w.senderRe.MatchString(s) {
			return true
		}
	}
	return false
}

func (w *Watcher) conversation(ctx context.Context, id string) *gmproto.Conversation {
	w.convMu.Lock()
	c := w.convs[id]
	w.convMu.Unlock()
	if c != nil || id == "" || w.cli == nil {
		return c
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, err := w.cli.GetConversation(cctx, id)
	if err != nil {
		w.log.Warn().Err(err).Str("conversation_id", id).Msg("could not fetch conversation info")
		return nil
	}
	w.convMu.Lock()
	w.convs[id] = c
	w.convMu.Unlock()
	return c
}

func (w *Watcher) handleMessage(ctx context.Context, m *gmproto.Message, conv *gmproto.Conversation, src string) {
	status := int(m.GetMessageStatus().GetStatus())
	if status < 100 || status >= 200 { // 1-99 outgoing, 200+ tombstones
		w.log.Debug().Int("status", status).Str("message_id", m.GetMessageID()).Msg("ignoring non-incoming message")
		return
	}
	body := messageText(m)
	if body == "" {
		w.log.Debug().Str("message_id", m.GetMessageID()).Msg("ignoring message without text")
		return
	}
	w.procMu.Lock()
	defer w.procMu.Unlock()
	idKey := "id:" + m.GetMessageID()
	if w.seen.Has(idKey) {
		return
	}
	if conv == nil {
		conv = w.conversation(ctx, m.GetConversationID())
	}
	cands := senderCandidates(conv, m)
	// Logged for EVERY incoming message (never the body) so the owner can tune GMWATCH_SENDER_REGEX.
	w.log.Info().Str("src", src).Str("conversation_id", m.GetConversationID()).Str("conversation_name", conv.GetName()).
		Str("participant_id", m.GetParticipantID()).Strs("sender_candidates", cands).
		Int("msg_type", int(m.GetType())).Int("status", status).Int("body_len", len(body)).Msg("incoming message")
	if !w.matchesSender(cands) {
		w.log.Debug().Msg("not an HDFC sender; ignored")
		return
	}
	if !strings.Contains(strings.ToLower(body), "credited") {
		w.log.Info().Str("message_id", m.GetMessageID()).Msg("HDFC message without 'credited'; ignored")
		return
	}
	ts := time.UnixMicro(m.GetTimestamp())
	if age := time.Since(ts); age > catchUpWindow {
		w.log.Info().Dur("age", age).Msg("HDFC credit older than 48h; ignored")
		return
	}
	it := Item{
		MessageID:  m.GetMessageID(),
		Sender:     NormalizeSender(cands),
		Message:    CleanText(body),
		ReceivedAt: FormatTS(ts),
		EnqueuedAt: time.Now().UTC(),
	}
	if err := w.q.Add(it); err != nil {
		w.log.Error().Err(err).Msg("!!! could not persist queue item; will retry on next catch-up")
		return
	}
	if err := w.seen.Mark(idKey, "hash:"+MessageHash(it.Sender, it.Message, it.ReceivedAt)); err != nil {
		w.log.Error().Err(err).Msg("could not persist seen store")
	}
	w.log.Info().Str("src", src).Str("message_id", it.MessageID).Str("sender_sent", it.Sender).Str("received_at", it.ReceivedAt).Msg("QUEUED HDFC credit for delivery")
}

// ---- catch-up ---------------------------------------------------------------

func (w *Watcher) catchUpLoop(ctx context.Context) {
	tick := time.NewTicker(periodicCatchUp)
	defer tick.Stop()
	for {
		var reason string
		select {
		case <-ctx.Done():
			return
		case reason = <-w.catchCh:
			if reason == "initial" {
				time.Sleep(10 * time.Second) // let postConnect / SetActiveSession finish
			} else {
				time.Sleep(3 * time.Second) // debounce bursts
			}
		case <-tick.C:
			reason = "periodic"
		}
		if w.loggedOut.Load() || w.cli == nil {
			continue
		}
		w.catchUp(ctx, reason)
	}
}

func (w *Watcher) listInbox(ctx context.Context) ([]*gmproto.Conversation, error) {
	resp, err := w.cli.ListConversations(ctx, &gmproto.ListConversationsRequest{
		Count: catchUpConvCount, Folder: gmproto.ListConversationsRequest_INBOX,
	})
	if err != nil {
		return nil, err
	}
	w.convMu.Lock()
	for _, c := range resp.GetConversations() {
		w.convs[c.GetConversationID()] = c
	}
	w.convMu.Unlock()
	return resp.GetConversations(), nil
}

func (w *Watcher) catchUp(ctx context.Context, reason string) {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	convs, err := w.listInbox(cctx)
	if err != nil {
		w.log.Error().Err(err).Str("reason", reason).Msg("catch-up: ListConversations failed")
		return
	}
	var matched []*gmproto.Conversation
	for _, c := range convs {
		var cands []string
		cands = nonEmpty(cands, c.GetName())
		for _, p := range c.GetParticipants() {
			if !p.GetIsMe() {
				cands = append(cands, participantLabels(p)...)
			}
		}
		if w.matchesSender(cands) {
			matched = append(matched, c)
		}
	}
	if len(matched) == 0 {
		w.log.Warn().Str("reason", reason).Int("conversations", len(convs)).Msg("catch-up: NO conversation matched the HDFC sender regex; listing what libgm sees (tune GMWATCH_SENDER_REGEX)")
		w.dumpConversations(convs, 30)
		return
	}
	queuedBefore := w.q.Len()
	scanned := 0
	for _, c := range matched {
		resp, err := w.cli.FetchMessages(cctx, c.GetConversationID(), catchUpMsgCount, nil)
		if err != nil {
			w.log.Error().Err(err).Str("conversation_id", c.GetConversationID()).Msg("catch-up: FetchMessages failed")
			continue
		}
		for _, m := range resp.GetMessages() {
			scanned++
			w.handleMessage(cctx, m, c, "catchup")
		}
	}
	w.log.Info().Str("reason", reason).Int("hdfc_conversations", len(matched)).Int("messages_scanned", scanned).
		Int("newly_queued", w.q.Len()-queuedBefore).Msg("catch-up done")
}

func (w *Watcher) dumpConversations(convs []*gmproto.Conversation, limit int) {
	for i, c := range convs {
		if i >= limit {
			break
		}
		var labels []string
		for _, p := range c.GetParticipants() {
			if !p.GetIsMe() {
				labels = append(labels, participantLabels(p)...)
			}
		}
		w.log.Info().Str("conversation_id", c.GetConversationID()).Str("name", c.GetName()).Strs("participants", labels).Msg("conversation")
	}
}

// cmdListConvs connects and prints the inbox conversations (names/numbers) so
// the owner can see how HDFC's sender appears.
func cmdListConvs() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	sess, err := LoadSession(cfg.DataDir)
	if err != nil {
		return err
	}
	log := newLogger(cfg.Debug)
	w, err := newWatcher(cfg, log, sess)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	w.ctx = ctx
	if err := w.connect(ctx); err != nil {
		return err
	}
	defer w.cli.Disconnect()
	select {
	case <-time.After(12 * time.Second):
	case <-ctx.Done():
		return nil
	}
	lctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	convs, err := w.listInbox(lctx)
	if err != nil {
		return err
	}
	for _, c := range convs {
		var labels []string
		for _, p := range c.GetParticipants() {
			if !p.GetIsMe() {
				labels = append(labels, participantLabels(p)...)
			}
		}
		hit := w.matchesSender(append(nonEmpty(nil, c.GetName()), labels...))
		fmt.Printf("%-6v id=%s name=%q participants=%q\n", hit, c.GetConversationID(), c.GetName(), labels)
	}
	return nil
}

// ---- delivery ---------------------------------------------------------------

func (w *Watcher) post(ctx context.Context, url string, payload any) (int, string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return 0, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &buf)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "gmwatch/0.1 (saathum upi watcher)")
	resp, err := w.httpc.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, strings.TrimSpace(string(b)), nil
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

func (w *Watcher) drainLoop(ctx context.Context) {
	for ctx.Err() == nil {
		it, ok, earliest := w.q.Next(time.Now())
		if !ok {
			wait := 30 * time.Second
			if !earliest.IsZero() {
				wait = time.Until(earliest)
			}
			select {
			case <-ctx.Done():
				return
			case <-w.q.wake:
			case <-time.After(wait):
			}
			continue
		}
		payload, _ := BuildIncoming(w.cfg.DeviceID, w.cfg.DeviceSecret, it.Sender, it.Message, it.ReceivedAt, time.Now(), RandomNonce())
		status, body, err := w.post(ctx, w.cfg.WebhookURL, payload)
		switch {
		case err != nil:
			w.log.Warn().Err(err).Int("attempt", it.Attempts+1).Str("message_id", it.MessageID).Msg("webhook unreachable; will retry with backoff")
			_ = w.q.Fail(it.MessageID, it.ReceivedAt, err.Error(), false)
		case status >= 200 && status < 300:
			w.log.Info().Int("status", status).Str("response", trunc(body, 200)).Str("message_id", it.MessageID).Msg("DELIVERED to webhook")
			if err := w.q.Remove(it.MessageID, it.ReceivedAt); err != nil {
				w.log.Error().Err(err).Msg("could not remove delivered item from queue")
			}
		default:
			permanent := (status == 400 || status == 404 || status == 413 || status == 422) &&
				!strings.Contains(body, "invalid_timestamp") && it.Attempts+1 >= 5
			lvl := w.log.Warn()
			if status == 401 || status == 403 || status == 410 || permanent {
				lvl = w.log.Error()
			}
			lvl.Int("status", status).Str("response", trunc(body, 200)).Int("attempt", it.Attempts+1).Bool("dead_lettered", permanent).
				Str("message_id", it.MessageID).Msg("webhook rejected message")
			if status == 401 {
				w.log.Error().Msg("!!! 401: check GMWATCH_DEVICE_ID / GMWATCH_DEVICE_SECRET and that the worker has HDFC_SMS_WATCHER_DEVICE_ID/SECRET set; also check the Mac clock (+-5 min)")
			}
			_ = w.q.Fail(it.MessageID, it.ReceivedAt, fmt.Sprintf("http %d %s", status, trunc(body, 120)), permanent)
		}
	}
}

func (w *Watcher) heartbeatLoop(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(20 * time.Second):
	}
	for {
		if why := w.healthReason(); why != "" {
			w.log.Warn().Str("reason", why).Msg("NOT sending heartbeat (unhealthy)")
		} else {
			hb := BuildHeartbeat(w.cfg.DeviceID, w.cfg.DeviceSecret, time.Now(), RandomNonce())
			status, body, err := w.post(ctx, w.cfg.HeartbeatURL, hb)
			if err != nil || status < 200 || status >= 300 {
				w.log.Warn().Err(err).Int("status", status).Str("response", trunc(body, 200)).Msg("heartbeat failed")
			} else {
				w.log.Info().Int("queued", w.q.Len()).Msg("heartbeat ok")
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(heartbeatEvery):
		}
	}
}
