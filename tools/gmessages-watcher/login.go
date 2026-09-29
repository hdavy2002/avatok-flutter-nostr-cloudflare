package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
)

const loginInstructions = `
=== gmwatch login (Google account pairing) ===

Use a DEDICATED Google account that is signed in on the payment phone
(Google Messages -> Settings -> Device pairing -> "Account pairing" must be ON).

1. On any computer open a PRIVATE / INCOGNITO browser window.
2. Sign in to the dedicated Google account, then open https://messages.google.com/web/
   (you may see "Use Messages for web" / pairing choices - just get the page to load).
3. Open DevTools -> Network tab, reload, find the request named "config"
   (URL ends in /web/config). Right-click it -> Copy -> "Copy as cURL".
   (Alternative: paste a JSON object of the cookies SID, HSID, SSID, APISID,
    SAPISID, OSID and __Secure-1PSIDTS.)
4. Paste it below, press Enter, then press Ctrl-D to finish.
5. CLOSE the private window WITHOUT signing out (signing out kills the cookies).
6. An emoji will appear here. Tap the SAME emoji in the notification/pairing
   prompt on the phone.

Paste now (Ctrl-D when done):
`

func cmdLogin(args []string) error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	var input []byte
	if len(args) > 0 && args[0] != "-" {
		input, err = os.ReadFile(args[0])
	} else {
		fmt.Fprint(os.Stderr, loginInstructions)
		input, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		return err
	}
	cookies, err := ParseCookies(string(input))
	if err != nil {
		return fmt.Errorf("could not read cookies: %w", err)
	}
	if miss := missingCookies(cookies); len(miss) > 0 {
		fmt.Fprintf(os.Stderr, "WARNING: these cookies were not found: %s (pairing will probably fail)\n", strings.Join(miss, ", "))
	}
	log := newLogger(cfg.Debug)

	ad := libgm.NewAuthData()
	ad.Cookies = cookies
	cli := libgm.NewClient(ad, nil, log.With().Str("component", "libgm").Logger(), exhttp.SensibleClientSettings)
	cli.SetEventHandler(func(evt any) { log.Debug().Type("event", evt).Msg("pre-pairing event") })

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()

	if err := cli.FetchConfig(ctx); err != nil {
		return fmt.Errorf("fetching messages.google.com config failed (cookies expired or wrong?): %w", err)
	}
	email := cli.Config.GetDeviceInfo().GetEmail()
	if email == "" {
		return errors.New("Google returned no account e-mail: the cookies are not a logged-in session. Redo steps 1-3")
	}
	fmt.Fprintf(os.Stderr, "Google account: %s\n", email)

	bgCtx, bgCancel := context.WithCancel(ctx)
	defer bgCancel()
	emoji, ps, err := cli.StartGaiaPairing(ctx, bgCtx)
	if err != nil {
		cli.Disconnect()
		switch {
		case errors.Is(err, libgm.ErrNoDevicesFound):
			return errors.New("no phone found: enable Device pairing / Account pairing in Google Messages on the phone for this Google account")
		case errors.Is(err, libgm.ErrPairingInitTimeout):
			return errors.New("phone did not respond: open Google Messages on the phone, make sure it is online and unrestricted by battery optimisation, then retry")
		case errors.Is(err, events.ErrCallerNoPermission):
			return errors.New("this Google account is not allowed to use Messages for web")
		}
		return fmt.Errorf("start pairing: %w", err)
	}
	fmt.Fprintf(os.Stderr, "\n      >>>  %s  <<<\n\nTap this emoji on the phone (you have a few minutes)...\n", emoji)

	phoneID, err := cli.FinishGaiaPairing(ctx, ps)
	bgCancel()
	cli.Disconnect()
	if err != nil {
		switch {
		case errors.Is(err, libgm.ErrIncorrectEmoji):
			return errors.New("wrong emoji tapped on the phone; run login again")
		case errors.Is(err, libgm.ErrPairingCancelled):
			return errors.New("pairing cancelled on the phone")
		case errors.Is(err, libgm.ErrPairingTimeout):
			return errors.New("pairing timed out; run login again")
		}
		return fmt.Errorf("finish pairing: %w", err)
	}
	sess := &Session{Email: email, PhoneID: phoneID, Auth: ad}
	if err := sess.Save(cfg.DataDir); err != nil {
		return fmt.Errorf("pairing worked but saving the session failed: %w", err)
	}
	fmt.Fprintf(os.Stderr, "\nPaired OK as %s. Session saved to %s (mode 0600).\nNow run: gmwatch run\n", email, sessionPath(cfg.DataDir))
	return nil
}

func newLogger(debug bool) zerolog.Logger {
	lvl := zerolog.InfoLevel
	if debug {
		lvl = zerolog.DebugLevel
	}
	w := zerolog.ConsoleWriter{Out: os.Stderr, NoColor: true, TimeFormat: time.RFC3339}
	return zerolog.New(w).Level(lvl).With().Timestamp().Logger()
}
