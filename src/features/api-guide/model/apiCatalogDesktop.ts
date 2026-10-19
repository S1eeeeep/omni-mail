import { localized as l, type ApiEndpoint } from "./apiCatalogTypes"

export const desktopEndpoints: ApiEndpoint[] = [
  {
    method: "GET",
    path: "/api/desktop/accounts",
    group: "auth",
    auth: "authenticated",
    title: l("桌面导入目录", "Desktop import catalog"),
    description: l(
      "仅设备令牌；返回当前用户的域名邮箱和可导入账号元数据，不解密凭据。",
      "Device tokens only; list owned mailboxes and importable accounts without decrypting credentials.",
    ),
    request: "No parameters",
    response:
      "200 · { accounts: [{ id, provider, email, name, ready, note }] }",
  },
  {
    method: "POST",
    path: "/api/desktop/credentials",
    group: "auth",
    auth: "authenticated",
    title: l("导入所选邮箱凭据", "Import selected mailbox credentials"),
    description: l(
      "仅设备令牌；重新验证密码和 MFA，最多导出 50 个自有账号。返回应用密码、原 Microsoft OAuth 应用与刷新令牌，或用于本地管理隐藏地址的 iCloud 地区、Apple 账户和 Cookie。禁止缓存和记录响应。",
      "Device tokens only; reverify password and MFA before exporting up to 50 owned accounts. Returns app passwords, original Microsoft OAuth credentials, or iCloud region, Apple account and cookies for local Hide My Email management. Do not cache or log the response.",
    ),
    request: "JSON · password, mfaCode?, accounts: [{ provider, id }]",
    response: "200 · { accounts }",
    exampleBody: {
      password: "your-password",
      mfaCode: "123456",
      accounts: [{ provider: "gmail", id: "account-id" }],
    },
  },
]
