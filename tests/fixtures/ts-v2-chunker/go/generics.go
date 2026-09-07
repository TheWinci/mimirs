package sample

func Identity[T any](value T) T {
	return value
}

func UseGeneric(value string) string {
	return Identity[string](value)
}
