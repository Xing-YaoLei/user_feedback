"""Cold-chain gateway batch receiver package."""

from .receiver import Receiver, ValidationError

__all__ = ["Receiver", "ValidationError"]
