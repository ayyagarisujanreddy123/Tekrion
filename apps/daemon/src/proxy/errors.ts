export class ProxyConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProxyConfigurationError";
    this.code = code;
  }
}

export class UnsafeBindError extends ProxyConfigurationError {
  constructor(host: string) {
    super(
      "UNSAFE_BIND",
      `Refusing to bind ${host} without explicit non-loopback consent.`,
    );
    this.name = "UnsafeBindError";
  }
}

export class ProxyLoopError extends ProxyConfigurationError {
  constructor(upstream: string) {
    super(
      "PROXY_LOOP",
      `Upstream ${upstream} resolves to the Tekrion proxy listener.`,
    );
    this.name = "ProxyLoopError";
  }
}
