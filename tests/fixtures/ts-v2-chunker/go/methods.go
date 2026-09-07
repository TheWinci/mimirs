package sample

type Cache struct {
	items map[string]string
}

func (cache *Cache) Get(key string) string {
	return cache.items[key]
}

func (cache *Cache) Load(loader func() string) string {
	return loader()
}

func (cache *Cache) Refresh(value string) string {
	return cache.normalize(value)
}
