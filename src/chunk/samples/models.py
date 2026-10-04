"""Sample module for chunking tests, written for this repository."""

import functools
from datetime import timedelta

from .fields import CharField, IntegerField

DEFAULT_TIMEOUT = 30
EMPTY_VALUES = (None, "", [], (), {})


class ModelBase(type):
    """Metaclass for all models."""

    def __new__(cls, name, bases, attrs, **kwargs):
        new_class = super().__new__(cls, name, bases, attrs)
        return new_class


class Article(metaclass=ModelBase):
    title = CharField(max_length=200)
    views = IntegerField(default=0)

    class Meta:
        ordering = ["-views"]

    # Shown in the admin list.
    def __str__(self):
        return self.title

    @property
    def is_popular(self):
        return self.views > 1000

    @functools.cache
    def expires_in(
        self,
        days=1,
    ):
        return timedelta(days=days)


def get_article(pk):
    return Article.objects.get(pk=pk)


if __name__ == "__main__":
    print(get_article(1))
