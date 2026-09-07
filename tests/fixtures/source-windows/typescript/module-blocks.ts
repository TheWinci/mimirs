export type RuntimeConfig = {
  endpoint: string;
  retries: number;
};

const config: RuntimeConfig = {
  endpoint: "https://example.test",
  retries: 3,
};

function initialize(value: RuntimeConfig): void {
  new URL(value.endpoint);
}

initialize(config);

if (config.retries > 0) {
  setTimeout(() => initialize(config), config.retries);
}
