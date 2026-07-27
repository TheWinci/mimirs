package sample

const DefaultLimit = 10

var ActiveStore = NewStore()

type Identifier string

type Store struct {
	Name  string
	count int
}

type Runner interface {
	Run(value string) error
}

func ParseIdentifier(value string) Identifier {
	return Identifier(value)
}
