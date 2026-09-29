package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	defaultWebhookURL = "https://api.avatok.ai/api/sms/incoming"
	defaultSenderRe   = `(?i)HDFCBK|HDFCBN|HDFCBANK|HDFC Bank`
)

type Config struct {
	DeviceID     string `json:"device_id"`
	DeviceSecret string `json:"device_secret"`
	WebhookURL   string `json:"webhook_url"`
	HeartbeatURL string `json:"heartbeat_url"`
	SenderRegex  string `json:"sender_regex"`

	DataDir string `json:"-"`
	Debug   bool   `json:"-"`
}

func dataDir() string {
	if d := os.Getenv("GMWATCH_DATA_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, "Library", "Application Support", "gmwatch")
}

func envOr(cur *string, key string) {
	if v := os.Getenv(key); v != "" {
		*cur = v
	}
}

// LoadConfig: defaults < config.json (0600 recommended) < environment.
func LoadConfig() (*Config, error) {
	c := &Config{WebhookURL: defaultWebhookURL, SenderRegex: defaultSenderRe, DataDir: dataDir()}
	p := filepath.Join(c.DataDir, "config.json")
	if st, err := os.Stat(p); err == nil {
		if st.Mode().Perm()&0o077 != 0 {
			fmt.Fprintf(os.Stderr, "WARNING: %s is readable by other users; run: chmod 600 %q\n", p, p)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(b, c); err != nil {
			return nil, fmt.Errorf("parse %s: %w", p, err)
		}
	}
	envOr(&c.DeviceID, "GMWATCH_DEVICE_ID")
	envOr(&c.DeviceSecret, "GMWATCH_DEVICE_SECRET")
	envOr(&c.WebhookURL, "GMWATCH_WEBHOOK_URL")
	envOr(&c.HeartbeatURL, "GMWATCH_HEARTBEAT_URL")
	envOr(&c.SenderRegex, "GMWATCH_SENDER_REGEX")
	c.Debug = os.Getenv("GMWATCH_DEBUG") == "1"
	if c.HeartbeatURL == "" {
		c.HeartbeatURL = deriveHeartbeatURL(c.WebhookURL)
	}
	return c, nil
}

// deriveHeartbeatURL turns ".../api/sms/incoming" into ".../api/sms/heartbeat".
func deriveHeartbeatURL(webhook string) string {
	const suf = "/incoming"
	if len(webhook) > len(suf) && webhook[len(webhook)-len(suf):] == suf {
		return webhook[:len(webhook)-len(suf)] + "/heartbeat"
	}
	return "https://api.avatok.ai/api/sms/heartbeat"
}

func (c *Config) RequireSigning() error {
	if c.DeviceID == "" || c.DeviceSecret == "" {
		return fmt.Errorf("GMWATCH_DEVICE_ID and GMWATCH_DEVICE_SECRET must be set (env or %s)", filepath.Join(c.DataDir, "config.json"))
	}
	return nil
}
