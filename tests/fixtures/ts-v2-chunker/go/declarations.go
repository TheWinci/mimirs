package sample

const (
	StatusReady = iota
	StatusDone
)

var (
	PrimaryStore = BuildStore()
	BackupStore  *Store
)

type Coordinates struct {
	X, Y int
	*Store
}
