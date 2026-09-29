package main

import (
	"encoding/json"
	"math/rand"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// writeFileAtomic writes 0600 via temp file + rename.
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// ---- seen store ------------------------------------------------------------

const seenTTL = 7 * 24 * time.Hour

type Seen struct {
	mu   sync.Mutex
	path string
	m    map[string]int64
}

func LoadSeen(path string) *Seen {
	s := &Seen{path: path, m: map[string]int64{}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s.m)
	}
	return s
}

func (s *Seen) Has(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.m[key]
	return ok
}

func (s *Seen) Mark(keys ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for _, k := range keys {
		s.m[k] = now.Unix()
	}
	for k, t := range s.m {
		if now.Sub(time.Unix(t, 0)) > seenTTL {
			delete(s.m, k)
		}
	}
	b, _ := json.Marshal(s.m)
	return writeFileAtomic(s.path, b)
}

// ---- persistent queue ------------------------------------------------------

// Item is a message waiting to be delivered. Signature/nonce/sent_at are NOT
// stored: they are regenerated on every attempt because the server only accepts
// sent_at within +-5 minutes.
type Item struct {
	MessageID  string    `json:"message_id"`
	Sender     string    `json:"sender"`
	Message    string    `json:"message"`
	ReceivedAt string    `json:"received_at"`
	EnqueuedAt time.Time `json:"enqueued_at"`
	Attempts   int       `json:"attempts"`
	NextTry    time.Time `json:"next_try"`
	LastError  string    `json:"last_error,omitempty"`
}

type Queue struct {
	mu       sync.Mutex
	path     string
	deadPath string
	items    []Item
	wake     chan struct{}
}

func LoadQueue(path, deadPath string) (*Queue, error) {
	q := &Queue{path: path, deadPath: deadPath, wake: make(chan struct{}, 1)}
	b, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(b, &q.items); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return q, nil
}

func (q *Queue) saveLocked() error {
	b, _ := json.MarshalIndent(q.items, "", " ")
	return writeFileAtomic(q.path, b)
}

func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func (q *Queue) Add(it Item) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, e := range q.items {
		if e.MessageID == it.MessageID && e.ReceivedAt == it.ReceivedAt {
			return nil
		}
	}
	q.items = append(q.items, it)
	err := q.saveLocked()
	select {
	case q.wake <- struct{}{}:
	default:
	}
	return err
}

// Next returns the first item that is due, or the time of the earliest retry.
func (q *Queue) Next(now time.Time) (Item, bool, time.Time) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var earliest time.Time
	for _, it := range q.items {
		if !it.NextTry.After(now) {
			return it, true, time.Time{}
		}
		if earliest.IsZero() || it.NextTry.Before(earliest) {
			earliest = it.NextTry
		}
	}
	return Item{}, false, earliest
}

func (q *Queue) Remove(id, receivedAt string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := q.items[:0]
	for _, e := range q.items {
		if !(e.MessageID == id && e.ReceivedAt == receivedAt) {
			out = append(out, e)
		}
	}
	q.items = out
	return q.saveLocked()
}

func backoff(attempts int) time.Duration {
	d := 2 * time.Second << uint(min(attempts, 8)) // 2s .. ~8.5min
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d + time.Duration(rand.Int63n(int64(d/4)+1))
}

// Fail records a failed attempt. If dead is true the item is moved to the
// dead-letter file instead of being retried.
func (q *Queue) Fail(id, receivedAt, errMsg string, dead bool) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i := range q.items {
		e := &q.items[i]
		if e.MessageID == id && e.ReceivedAt == receivedAt {
			e.Attempts++
			e.LastError = errMsg
			e.NextTry = time.Now().Add(backoff(e.Attempts))
			if dead {
				if b, err := json.Marshal(*e); err == nil {
					if f, err := os.OpenFile(q.deadPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
						f.Write(append(b, '\n'))
						f.Close()
					}
				}
				q.items = append(q.items[:i], q.items[i+1:]...)
			}
			break
		}
	}
	return q.saveLocked()
}
