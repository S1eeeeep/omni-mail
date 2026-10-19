import type { Env } from "../../app/types"
import { GmailAccountStore } from "../gmail/gmail-store"
import { QqMailAccountStore } from "../qq-mail/qq-mail-store"
import { NaverMailAccountStore } from "../naver-mail/naver-mail-store"
import { YandexMailAccountStore } from "../yandex-mail/yandex-mail-store"
import { ICloudAccountStore } from "../icloud/icloud-store"
import { MicrosoftAccountStore } from "../microsoft/microsoft-store"
import { LinuxDoMailAccountStore } from "../linux-do-mail/linux-do-mail-store"
import type { DesktopAccount } from "./desktop-catalog"

export async function desktopSecret(
  env: Env,
  userId: string,
  item: DesktopAccount,
) {
  switch (item.provider) {
    case "omnimail":
      return item
    case "gmail": {
      const account = await new GmailAccountStore(env, userId).get(item.id)
      return { ...item, secret: account.appPassword }
    }
    case "qq": {
      const account = await new QqMailAccountStore(env, userId).get(item.id)
      return { ...item, secret: account.authorizationCode }
    }
    case "naver": {
      const account = await new NaverMailAccountStore(env, userId).get(item.id)
      return { ...item, secret: account.appPassword }
    }
    case "yandex": {
      const account = await new YandexMailAccountStore(env, userId).get(item.id)
      return { ...item, secret: account.appPassword }
    }
    case "icloud": {
      const account = await new ICloudAccountStore(env, userId).get(item.id)
      // 桌面端将会话加密保存并直接管理隐藏地址；不再依赖本服务代理 Apple 请求。
      return {
        ...item,
        secret: account.appPassword,
        icloudHost: account.host,
        appleId: account.realEmail,
        cookies: account.cookies,
      }
    }
    case "microsoft": {
      const account = await new MicrosoftAccountStore(env, userId).get(item.id)
      if (account.authMode !== "oauth2") throw new Error("DESKTOP_AUTH_MODE")
      return {
        ...item,
        clientId: account.clientId,
        authority: account.authority,
        refreshToken: account.refreshToken,
      }
    }
    case "linuxdo": {
      const account = await new LinuxDoMailAccountStore(env, userId).get()
      if (account.id !== item.id) throw new Error("DESKTOP_ACCOUNT_CHANGED")
      return { ...item, secret: account.password }
    }
    default:
      throw new Error("DESKTOP_PROVIDER_INVALID")
  }
}
