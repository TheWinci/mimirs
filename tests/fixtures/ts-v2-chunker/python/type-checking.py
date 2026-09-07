from typing import TYPE_CHECKING
import typing

if TYPE_CHECKING:
    from package.models import User

if typing.TYPE_CHECKING:
    from package.services import Service as ServiceType
else:
    from package.runtime import User as RuntimeUser
