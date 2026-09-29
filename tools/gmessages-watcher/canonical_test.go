package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Known-answer values computed with Node's crypto exactly as the worker does in
// hdfcSmsIncoming: [device,sender,message,received,b.sim_slot??”,hash,nonce,sent].join('\n')
// with sim_slot undefined, hmacSha256Hex(secret, ...) and sha256Hex(`${sender}|${message}|${received}`).
const (
	wantHash = "40e2412c9666d721733be43314cc8feeb80f92de693380bd14b2bc6f4b692b34"
	wantSig  = "6e169050956ce25c95ff9ef66079a1b17f3c38f5af25c12adcc93fbcce71f410"
	wantHB   = "dc13db2e5a5561416cad4a0e45e0477dcd225f6a5bb4ae5cb6e84c2ee9f25bec"
)

func TestIncomingMatchesServerKnownAnswer(t *testing.T) {
	now := time.Date(2026, 9, 17, 10, 30, 5, 0, time.UTC)
	p, _ := BuildIncoming(sampleDev, sampleSec, "HDFCBK", sampleSMS, "2026-09-17T10:30:00Z", now, sampleNon)
	if p.MessageHash != wantHash {
		t.Fatalf("hash %s != %s", p.MessageHash, wantHash)
	}
	if p.Signature != wantSig {
		t.Fatalf("signature %s != %s", p.Signature, wantSig)
	}
	if p.SentAt != "2026-09-17T10:30:05Z" {
		t.Fatalf("sent_at %s", p.SentAt)
	}
}

// Independent re-implementation of the TypeScript server check (does not call our helpers).
func TestIncomingVerifiedLikeServer(t *testing.T) {
	now := time.Date(2026, 9, 17, 10, 30, 5, 0, time.UTC)
	p, _ := BuildIncoming(sampleDev, sampleSec, "HDFCBK", sampleSMS, "2026-09-17T10:30:00Z", now, sampleNon)

	simSlot := "" // b.sim_slot ?? ''  (field omitted from JSON)
	joined := strings.Join([]string{p.DeviceID, p.Sender, p.Message, p.ReceivedAt, simSlot, p.MessageHash, p.Nonce, p.SentAt}, "\n")
	mac := hmac.New(sha256.New, []byte(sampleSec))
	mac.Write([]byte(joined))
	if got := hex.EncodeToString(mac.Sum(nil)); got != p.Signature {
		t.Fatalf("server-style signature %s != payload %s", got, p.Signature)
	}
	h := sha256.Sum256([]byte(p.Sender + "|" + p.Message + "|" + p.ReceivedAt))
	if hex.EncodeToString(h[:]) != p.MessageHash {
		t.Fatal("server-style message_hash mismatch")
	}
	// server field validators
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.MessageHash) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(p.Signature) {
		t.Fatal("hash/signature not 64 hex")
	}
	// server timestampInterval() regex
	tsRe := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|\+03:00)$`)
	if !tsRe.MatchString(p.ReceivedAt) || !tsRe.MatchString(p.SentAt) {
		t.Fatal("timestamp format rejected by server regex")
	}
	if !passesServerSender(p.Sender) {
		t.Fatal("sender rejected by isHdfcSender")
	}
}

func TestHeartbeatKnownAnswer(t *testing.T) {
	now := time.Date(2026, 9, 17, 10, 30, 5, 0, time.UTC)
	hb := BuildHeartbeat(sampleDev, sampleSec, now, sampleNon)
	if hb.Signature != wantHB {
		t.Fatalf("heartbeat sig %s != %s", hb.Signature, wantHB)
	}
}

func TestNormalizeSender(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{"HDFC Bank", "VM-HDFCBK-S"}, "VM-HDFCBK-S"},
		{[]string{"HDFC Bank"}, "HDFCBK"},
		{[]string{"AX-HDFCBN"}, "AX-HDFCBN"},
		{[]string{"hdfcbk"}, "hdfcbk"},
		{nil, "HDFCBK"},
		{[]string{"+919970176848"}, "HDFCBK"},
	}
	for _, c := range cases {
		if got := NormalizeSender(c.in); got != c.want {
			t.Errorf("%v: got %q want %q", c.in, got, c.want)
		}
	}
}

func TestParseCookies(t *testing.T) {
	chrome := "curl 'https://messages.google.com/web/config' \\\n  -H 'accept: */*' \\\n  -b 'SID=aaa; HSID=bbb; OSID=ccc; SSID=ddd; APISID=eee; SAPISID=fff; __Secure-1PSIDTS=ggg'"
	firefox := `curl 'https://messages.google.com/web/config' -H 'User-Agent: x' -H 'Cookie: SID=aaa; HSID=bbb; OSID=ccc; SSID=ddd; APISID=eee; SAPISID=fff'`
	js := `{"SID":"aaa","HSID":"bbb","OSID":"ccc","SSID":"ddd","APISID":"eee","SAPISID":"fff"}`
	bare := "Cookie: SID=aaa; HSID=bbb; OSID=ccc; SSID=ddd; APISID=eee; SAPISID=fff"
	for name, in := range map[string]string{"chrome": chrome, "firefox": firefox, "json": js, "bare": bare} {
		m, err := ParseCookies(in)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if miss := missingCookies(m); len(miss) != 0 {
			t.Fatalf("%s: missing %v", name, miss)
		}
		if m["SID"] != "aaa" {
			t.Fatalf("%s: SID=%q", name, m["SID"])
		}
	}
	if _, err := ParseCookies("curl 'https://x'"); err == nil {
		t.Fatal("expected error for cookie-less curl")
	}
}

func TestQueuePersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	qp, dp := filepath.Join(dir, "q.json"), filepath.Join(dir, "dead.jsonl")
	q, err := LoadQueue(qp, dp)
	if err != nil {
		t.Fatal(err)
	}
	it := Item{MessageID: "m1", Sender: "HDFCBK", Message: "x credited", ReceivedAt: "2026-09-17T10:30:00Z"}
	if err := q.Add(it); err != nil {
		t.Fatal(err)
	}
	_ = q.Add(it) // duplicate ignored
	q2, err := LoadQueue(qp, dp)
	if err != nil {
		t.Fatal(err)
	}
	if q2.Len() != 1 {
		t.Fatalf("len=%d", q2.Len())
	}
	_ = q2.Fail("m1", it.ReceivedAt, "boom", false)
	if _, ok, _ := q2.Next(time.Now()); ok {
		t.Fatal("item should be backing off")
	}
	if err := q2.Remove("m1", it.ReceivedAt); err != nil || q2.Len() != 0 {
		t.Fatal("remove failed")
	}
}

func TestSeenPersists(t *testing.T) {
	p := filepath.Join(t.TempDir(), "seen.json")
	s := LoadSeen(p)
	if err := s.Mark("id:1"); err != nil {
		t.Fatal(err)
	}
	if !LoadSeen(p).Has("id:1") || LoadSeen(p).Has("id:2") {
		t.Fatal("seen store broken")
	}
}

func TestDeriveHeartbeatURL(t *testing.T) {
	if got := deriveHeartbeatURL("https://api.avatok.ai/api/sms/incoming"); got != "https://api.avatok.ai/api/sms/heartbeat" {
		t.Fatal(got)
	}
}
