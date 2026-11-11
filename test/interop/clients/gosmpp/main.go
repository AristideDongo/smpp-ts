// gosmpp client for the smpp-ts server interop suite.
//
//	go run ./test/interop/clients/gosmpp <host> <port>
//
// Binds as transceiver, sends a short GSM7 message and a long UCS2 one (split by gosmpp itself),
// asks for receipts, waits for them and for one MO, unbinds, and prints a JSON summary on the last line.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/linxGnu/gosmpp"
	"github.com/linxGnu/gosmpp/data"
	"github.com/linxGnu/gosmpp/pdu"
)

type expected struct {
	SystemID string `json:"systemId"`
	Password string `json:"password"`
	Short    string `json:"short"`
	Long     string `json:"long"`
}

type summary struct {
	Submitted []string `json:"submitted"`
	Receipts  []string `json:"receipts"`
	MO        []string `json:"mo"`
}

var receiptID = regexp.MustCompile(`id:(\S+)`)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gosmpp <host> <port>")
		os.Exit(2)
	}
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "expected.json"))
	must(err)
	var exp expected
	must(json.Unmarshal(raw, &exp))

	var mu sync.Mutex
	var sum summary
	onPDU := func(p pdu.PDU, _ bool) {
		mu.Lock()
		defer mu.Unlock()
		switch pd := p.(type) {
		case *pdu.SubmitSMResp:
			sum.Submitted = append(sum.Submitted, pd.MessageID)
		case *pdu.DeliverSM:
			text, _ := pd.Message.GetMessage()
			if pd.EsmClass&0x04 != 0 {
				if m := receiptID.FindStringSubmatch(text); m != nil {
					sum.Receipts = append(sum.Receipts, m[1])
				}
			} else {
				sum.MO = append(sum.MO, text)
			}
		}
	}

	session, err := gosmpp.NewSession(
		gosmpp.TRXConnector(gosmpp.NonTLSDialer, gosmpp.Auth{
			SMSC:     os.Args[1] + ":" + os.Args[2],
			SystemID: exp.SystemID,
			Password: exp.Password,
		}),
		gosmpp.Settings{
			EnquireLink: 5 * time.Second,
			ReadTimeout: 10 * time.Second,
			OnPDU:       onPDU,
		},
		-1, // no rebinding
	)
	must(err)

	submit := func(text string, enc data.Encoding) {
		sm := newSubmit()
		// gosmpp: SetLongMessageWithEnc must always be followed by Split() (one part if short enough).
		must(sm.Message.SetLongMessageWithEnc(text, enc))
		parts, err := sm.Split()
		must(err)
		for _, part := range parts {
			must(session.Transceiver().Submit(part))
		}
	}
	submit(exp.Short, data.GSM7BIT)
	submit(exp.Long, data.UCS2)

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(sum.Submitted) >= 3 && len(sum.Receipts) >= len(sum.Submitted) && len(sum.MO) > 0
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	must(session.Close())

	mu.Lock()
	out, _ := json.Marshal(sum)
	mu.Unlock()
	fmt.Println(string(out))
}

func newSubmit() *pdu.SubmitSM {
	src := pdu.NewAddress()
	src.SetTon(5)
	src.SetNpi(0)
	must(src.SetAddress("GOSMPP"))
	dst := pdu.NewAddress()
	dst.SetTon(1)
	dst.SetNpi(1)
	must(dst.SetAddress("2250700000000"))
	sm := pdu.NewSubmitSM().(*pdu.SubmitSM)
	sm.SourceAddr = src
	sm.DestAddr = dst
	sm.RegisteredDelivery = 1
	return sm
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
