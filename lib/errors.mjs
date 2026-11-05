// Error classes carrying the CLI exit-code convention:
// 0 ok, 1 usage or validation, 2 state error, 3 git conflict or refusal.

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.exitCode = 1; }
}

export class StateError extends Error {
  constructor(message) { super(message); this.name = 'StateError'; this.exitCode = 2; }
}

export class RefusalError extends Error {
  constructor(message) { super(message); this.name = 'RefusalError'; this.exitCode = 3; }
}

export class GitError extends Error {
  constructor(message) { super(message); this.name = 'GitError'; this.exitCode = 3; }
}
