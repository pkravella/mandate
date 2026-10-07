Plan: refactor the retry helper, then the parser, then the paginator.

This is a long task. Set `expiresInMinutes: 1440` so the token does not expire
mid-run and force a restart.
