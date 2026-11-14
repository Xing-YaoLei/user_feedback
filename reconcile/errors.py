"""Exception types that produce a clean, user-facing error message."""


class ReconcileError(Exception):
    """An expected failure: bad input, bad arguments, or unusable output path.

    The CLI turns this into ``reconcile: error: <message>`` and exit status 2.
    """


class InputError(ReconcileError):
    """A problem with the manifest or target snapshot contents."""
