package sample

type Handler struct{}

func (Handler) Run() {}

func (*Handler) Stop() {}

func MethodExpressions(handler Handler, pointer *Handler) {
	Handler.Run(handler)
	(*Handler).Stop(pointer)
	handler.Run()
	pointer.Stop()

	missing := Handler.Unknown
	missing(handler)
}
