import { defaultConfig } from "./config.ts";
import { UserService } from "./services/user-service.ts";

export function start(): string {
  const service = new UserService(defaultConfig.endpoint);
  return service.describe({ id: "user-1", name: "Ada" });
}
