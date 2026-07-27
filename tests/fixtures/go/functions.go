package sample

func Greet(name string) string {
	return FormatName(name)
}

func Fetch(loader func() string) string {
	return loader()
}

func Transform(value string) string {
	normalize := func(input string) string {
		return Clean(input)
	}

	return normalize(value)
}
