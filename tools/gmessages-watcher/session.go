package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
)

// Session is what `gmwatch login` writes to session.json (0600). It holds the
// Google cookies AND the pairing keys: treat it like a password.
type Session struct {
	Version int             `json:"version"`
	SavedAt time.Time       `json:"saved_at"`
	Email   string          `json:"email"`
	PhoneID string          `json:"phone_id"`
	Auth    *libgm.AuthData `json:"auth"`
}

func sessionPath(dir string) string { return filepath.Join(dir, "session.json") }

func LoadSession(dir string) (*Session, error) {
	b, err := os.ReadFile(sessionPath(dir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("no session at %s - run `gmwatch login` first", sessionPath(dir))
		}
		return nil, err
	}
	var s Session
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("corrupt session file: %w", err)
	}
	if s.Auth == nil {
		return nil, errors.New("session file has no auth data - run `gmwatch login` again")
	}
	return &s, nil
}

func (s *Session) Save(dir string) error {
	s.SavedAt = time.Now().UTC()
	s.Version = 1
	// Cookies are mutated by libgm under this lock.
	s.Auth.CookiesLock.RLock()
	b, err := json.MarshalIndent(s, "", " ")
	s.Auth.CookiesLock.RUnlock()
	if err != nil {
		return err
	}
	return writeFileAtomic(sessionPath(dir), b)
}

// ---- cookie parsing --------------------------------------------------------

var requiredCookies = []string{"SID", "HSID", "OSID", "SSID", "APISID", "SAPISID"}

var (
	reHeaderCookie = regexp.MustCompile(`(?is)(?:-H|--header)\s+\$?(?:'cookie:\s*([^']*)'|"cookie:\s*([^"]*)")`)
	reBFlag        = regexp.MustCompile(`(?is)(?:-b|--cookie)\s+\$?(?:'([^']*)'|"([^"]*)")`)
)

// ParseCookies accepts: a JSON object {"SID":"..."}, a cURL command (Chrome
// "Copy as cURL" uses -b '...', Firefox uses -H 'Cookie: ...'), a "Cookie: a=b; c=d"
// header line, or a bare "a=b; c=d" string.
func ParseCookies(in string) (map[string]string, error) {
	in = strings.TrimSpace(in)
	if in == "" {
		return nil, errors.New("empty input")
	}
	if strings.HasPrefix(in, "{") {
		m := map[string]string{}
		if err := json.Unmarshal([]byte(in), &m); err != nil {
			return nil, fmt.Errorf("invalid JSON: %w", err)
		}
		return m, nil
	}
	// Chrome DevTools -> Application -> Cookies table copied as rows:
	// "name<TAB>value<TAB>domain<TAB>..." one cookie per line.
	if strings.Contains(in, "\t") && !strings.Contains(strings.ToLower(in), "curl") {
		out := map[string]string{}
		for _, line := range strings.Split(in, "\n") {
			f := strings.Split(strings.TrimRight(line, "\r"), "\t")
			if len(f) < 2 {
				continue
			}
			k, v := strings.TrimSpace(f[0]), strings.TrimSpace(f[1])
			if k != "" && v != "" {
				out[k] = v
			}
		}
		if len(out) > 0 {
			return out, nil
		}
	}
	raw := ""
	if strings.Contains(strings.ToLower(in), "curl") {
		if m := reHeaderCookie.FindStringSubmatch(in); m != nil {
			raw = m[1] + m[2]
		} else if m := reBFlag.FindStringSubmatch(in); m != nil {
			raw = m[1] + m[2]
		} else {
			return nil, errors.New("this looks like a cURL command but has no cookie (-b / -H 'Cookie: ...') part; copy the request to messages.google.com/web/config")
		}
	} else {
		raw = in
		if i := strings.Index(strings.ToLower(raw), "cookie:"); i >= 0 && i < 3 {
			raw = raw[i+len("cookie:"):]
		}
	}
	out := map[string]string{}
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	if len(out) == 0 {
		return nil, errors.New("no cookies found in input")
	}
	return out, nil
}

func missingCookies(m map[string]string) []string {
	var miss []string
	for _, k := range requiredCookies {
		if m[k] == "" {
			miss = append(miss, k)
		}
	}
	return miss
}
