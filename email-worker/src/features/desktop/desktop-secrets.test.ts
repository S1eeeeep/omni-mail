import { beforeEach, expect, it, vi } from "vitest"
import type { Env } from "../../app/types"
import { desktopSecret } from "./desktop-secrets"

const mock = vi.hoisted(() => ({ get: vi.fn(), owners: [] as string[] }))
vi.mock("../icloud/icloud-store", () => ({
  ICloudAccountStore: class {
    constructor(_env: unknown, userId: string) {
      mock.owners.push(userId)
    }
    get = mock.get
  },
}))

beforeEach(() => {
  mock.get.mockReset()
  mock.owners.length = 0
})

it("导出所选用户的 iCloud 本地会话，同时保留 IMAP 应用密码", async () => {
  mock.get.mockResolvedValue({
    appPassword: "test-app-password",
    host: "icloud.com.cn",
    realEmail: "apple@example.com",
    cookies: { session: "test-cookie" },
  })
  const result = await desktopSecret({} as Env, "owner-id", {
    id: "icloud-selected",
    provider: "icloud",
    email: "main@icloud.com",
    name: "主邮箱",
    ready: true,
    note: "",
  })
  expect(mock.owners).toEqual(["owner-id"])
  expect(mock.get).toHaveBeenCalledExactlyOnceWith("icloud-selected")
  expect(result).toMatchObject({
    secret: "test-app-password",
    icloudHost: "icloud.com.cn",
    appleId: "apple@example.com",
    cookies: { session: "test-cookie" },
  })
})
