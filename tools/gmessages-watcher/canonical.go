package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"time"
)

// This file mirrors, byte for byte, the signing spec of the companion
// (sms-companion/lib/src/core/canonical.dart) and the worker
// (worker/src/routes/hdfc_sms_payments.ts: hdfcSmsIncoming / hdfcSmsHeartbeat).
//
//   message_hash = sha256_hex( sender + "|" + message + "|" + received_at )
//   string_to_sign (incoming) =
//       device_id \n sender \n message \n received_at \n sim_slot \n message_hash \n nonce \n sent_at
//   string_to_sign (heartbeat) = device_id \n nonce \n sent_at
//   signature = hmac_sha256_hex( secret, string_to_sign )
//
// The watcher never has a SIM slot, so `sim_slot` is omitted from the JSON body;
// the server then uses `b.sim_slot ?? ''`, i.e. an EMPTY string in that position.

// tsLayout is whole-second UTC ISO-8601. The server's timestampInterval() accepts
// "YYYY-MM-DDTHH:MM:SS(.mmm)?(Z|+03:00)".
const tsLayout = "2006-01-02T15:04:05Z"

func FormatTS(t time.Time) string { return t.UTC().Truncate(time.Second).Format(tsLayout) }

// CleanText makes sure the text survives a JSON round trip unchanged (invalid
// UTF-8 would otherwise be replaced on encode and break the hash/signature).
func CleanText(s string) string { return strings.ToValidUTF8(s, "�") }

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func MessageHash(sender, message, receivedAt string) string {
	return sha256Hex(sender + "|" + message + "|" + receivedAt)
}

// IncomingStringToSign; simSlot is "" when omitted (watcher default).
func IncomingStringToSign(deviceID, sender, message, receivedAt, simSlot, hash, nonce, sentAt string) string {
	return strings.Join([]string{deviceID, sender, message, receivedAt, simSlot, hash, nonce, sentAt}, "\n")
}

func HeartbeatStringToSign(deviceID, nonce, sentAt string) string {
	return strings.Join([]string{deviceID, nonce, sentAt}, "\n")
}

func Sign(stringToSign, secret string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(stringToSign))
	return hex.EncodeToString(m.Sum(nil))
}

func RandomNonce() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// IncomingPayload is the JSON body for POST /api/sms/incoming. sim_slot omitted on purpose.
type IncomingPayload struct {
	DeviceID    string `json:"device_id"`
	Sender      string `json:"sender"`
	Message     string `json:"message"`
	ReceivedAt  string `json:"received_at"`
	SentAt      string `json:"sent_at"`
	MessageHash string `json:"message_hash"`
	Nonce       string `json:"nonce"`
	Signature   string `json:"signature"`
}

type HeartbeatPayload struct {
	DeviceID  string `json:"device_id"`
	Nonce     string `json:"nonce"`
	SentAt    string `json:"sent_at"`
	Signature string `json:"signature"`
}

func BuildIncoming(deviceID, secret, sender, message, receivedAt string, now time.Time, nonce string) (IncomingPayload, string) {
	sender = CleanText(sender)
	message = CleanText(message)
	sentAt := FormatTS(now)
	hash := MessageHash(sender, message, receivedAt)
	sts := IncomingStringToSign(deviceID, sender, message, receivedAt, "", hash, nonce, sentAt)
	return IncomingPayload{
		DeviceID: deviceID, Sender: sender, Message: message, ReceivedAt: receivedAt,
		SentAt: sentAt, MessageHash: hash, Nonce: nonce, Signature: Sign(sts, secret),
	}, sts
}

func BuildHeartbeat(deviceID, secret string, now time.Time, nonce string) HeartbeatPayload {
	sentAt := FormatTS(now)
	return HeartbeatPayload{DeviceID: deviceID, Nonce: nonce, SentAt: sentAt,
		Signature: Sign(HeartbeatStringToSign(deviceID, nonce, sentAt), secret)}
}

// serverSenderRe is the server's isHdfcSender() (worker/src/lib/hdfc_sms_smoke.ts).
var serverSenderRe = regexp.MustCompile(`(?i)^(?:[A-Z0-9]{2}-)?(?:HDFCBK|HDFCBN|HDFCBANK)(?:-[A-Z])?$`)

func passesServerSender(s string) bool { return len(s) <= 32 && serverSenderRe.MatchString(s) }

// NormalizeSender: libgm gives display names ("HDFC Bank") as often as short codes
// ("VM-HDFCBK-S"). Use the first candidate that already passes the server's
// isHdfcSender(); otherwise fall back to the canonical short code "HDFCBK".
func NormalizeSender(candidates []string) string {
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c != "" && passesServerSender(c) {
			return c
		}
	}
	return "HDFCBK"
}
