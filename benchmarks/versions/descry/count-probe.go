package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/jKiler/descry/internal/chunk"
	"github.com/jKiler/descry/internal/embed"
	"github.com/jKiler/descry/internal/index"
	"os"
	"runtime"
	"time"
)

type Stats struct {
	Files      int     `json:"files"`
	Bytes      int     `json:"bytes"`
	Chunks     int     `json:"chunks"`
	Unique     int     `json:"unique_embed_texts"`
	Tokens     int     `json:"model_input_tokens"`
	FullTokens int     `json:"untruncated_tokens"`
	Truncated  int     `json:"truncated_chunks"`
	AtLimit    int     `json:"at_256_tokens"`
	Seconds    float64 `json:"scan_seconds"`
}

func main() {
	root := os.Args[1]
	wp, err := embed.LoadWordPiece("internal/embed/testdata/vocab.txt", 1000000000)
	if err != nil {
		panic(err)
	}
	result := map[string]interface{}{"root": root, "gomaxprocs": runtime.GOMAXPROCS(0), "onnx_calls": 0}
	for _, mode := range []string{"ast-go", "ts"} {
		c, err := chunk.ByName(mode)
		if err != nil {
			panic(err)
		}
		st := Stats{}
		seen := map[[32]byte]bool{}
		start := time.Now()
		err = index.WalkFiles(root, root, func(path, text string) error {
			st.Files++
			st.Bytes += len(text)
			for _, v := range c.Chunk(path, text) {
				s := v.EmbedText
				if s == "" {
					s = v.Path + "\n" + v.Content
				}
				st.Chunks++
				h := sha256.Sum256([]byte(s))
				if seen[h] {
					continue
				}
				seen[h] = true
				st.Unique++
				n := len(wp.Encode(s).IDs)
				st.FullTokens += n
				if n > 256 {
					st.Truncated++
				}
				if n >= 256 {
					st.AtLimit++
				}
				st.Tokens += min(256, n)
			}
			return nil
		})
		if err != nil {
			panic(err)
		}
		st.Seconds = time.Since(start).Seconds()
		result[mode] = st
		fmt.Fprintln(os.Stderr, mode, st.Files, st.Chunks, st.Seconds)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}
}
