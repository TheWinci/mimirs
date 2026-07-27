import type { User } from "../models/user.ts";

export class UserService {
  constructor(private readonly endpoint: string) {}

  describe(user: User): string {
    return `${user.name} (${user.id}) via ${this.endpoint}`;
  }
}
