export interface RuntimeConfig {
  endpoint: string;
  retries: number;
}

export const defaultConfig: RuntimeConfig = {
  endpoint: "https://example.test",
  retries: 2,
};

export function withEndpoint(endpoint: string): RuntimeConfig {
  return { ...defaultConfig, endpoint };
}
