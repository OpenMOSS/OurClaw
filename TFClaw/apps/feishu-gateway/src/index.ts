import fs from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  type CaptureSource,
  type ClientCommand,
  type RelayMessage,
  type ScreenCapture,
  type TerminalSnapshot,
  type TerminalSummary,
  jsonStringify,
  safeJsonParse,
} from "@tfclaw/protocol";
import WebSocket from "ws";
import { formatGatewayErrorFeedback } from "./error-feedback.js";

type ChannelName = "whatsapp" | "telegram" | "discord" | "feishu" | "mochat" | "dingtalk" | "email" | "slack" | "qq";

interface BaseChannelConfig {
  enabled: boolean;
  allowFrom: string[];
}

interface WhatsAppChannelConfig extends BaseChannelConfig {
  bridgeUrl: string;
  bridgeToken: string;
}

interface TelegramChannelConfig extends BaseChannelConfig {
  token: string;
  proxy: string;
  replyToMessage: boolean;
}

interface DiscordChannelConfig extends BaseChannelConfig {
  token: string;
  gatewayUrl: string;
  intents: number;
}

type FeishuRenderMode = "auto" | "raw" | "card";
type FeishuMessageType = "post" | "interactive" | "image" | "file" | "audio" | "media";

interface FeishuSendOptions {
  replyToMessageId?: string;
  replyInThread?: boolean;
}

interface FeishuChannelConfig extends BaseChannelConfig {
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
  disableProxy: boolean;
  noProxyHosts: string[];
  renderMode: FeishuRenderMode;
}

interface MochatChannelConfig extends BaseChannelConfig {
  baseUrl: string;
  clawToken: string;
}

interface DingTalkChannelConfig extends BaseChannelConfig {
  clientId: string;
  clientSecret: string;
}

interface EmailChannelConfig extends BaseChannelConfig {
  imapHost: string;
  imapUsername: string;
  imapPassword: string;
  smtpHost: string;
  smtpUsername: string;
  smtpPassword: string;
}

interface SlackChannelConfig extends BaseChannelConfig {
  botToken: string;
  appToken: string;
  groupPolicy: string;
}

interface QQChannelConfig extends BaseChannelConfig {
  appId: string;
  secret: string;
}

interface ChannelsConfig {
  whatsapp: WhatsAppChannelConfig;
  telegram: TelegramChannelConfig;
  discord: DiscordChannelConfig;
  feishu: FeishuChannelConfig;
  mochat: MochatChannelConfig;
  dingtalk: DingTalkChannelConfig;
  email: EmailChannelConfig;
  slack: SlackChannelConfig;
  qq: QQChannelConfig;
}

interface RelayConfig {
  token: string;
  url: string;
}

interface NexChatBotConfig {
  enabled: boolean;
  baseUrl: string;
  runPath: string;
  apiKey: string;
  timeoutMs: number;
}

interface OpenClawBridgeConfig {
  enabled: boolean;
  openclawRoot: string;
  stateDir: string;
  sharedEnvPath: string;
  sharedSkillsDir: string;
  userHomeRoot: string;
  userPrefix: string;
  tmuxSessionPrefix: string;
  gatewayHost: string;
  gatewayPortBase: number;
  gatewayPortMax: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  sessionKey: string;
  nodePath: string;
  configTemplatePath: string;
  autoBuildDist: boolean;
  allowAutoCreateUser: boolean;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuVerificationToken: string;
  feishuEncryptKey: string;
  feishuWebhookPortOffset: number;
}

interface GatewayConfig {
  relay: RelayConfig;
  nexchatbot: NexChatBotConfig;
  openclawBridge: OpenClawBridgeConfig;
  channels: ChannelsConfig;
}

interface LoadedGatewayConfig {
  configPath: string;
  fromFile: boolean;
  config: GatewayConfig;
}

interface RelayCache {
  terminals: Map<string, TerminalSummary>;
  snapshots: Map<string, TerminalSnapshot>;
}

interface PendingCapture {
  resolve: (capture: ScreenCapture) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingCaptureSourceList {
  resolve: (sources: CaptureSource[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingCommandResult {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (output: string, source?: string) => void | Promise<void>;
}

interface EarlyCommandProgress {
  output: string;
  progressSource?: string;
  at: number;
}

interface ChatCaptureSelection {
  options: CaptureSource[];
  terminalId?: string;
  createdAt: number;
}

type ChatInteractionMode = "tfclaw" | "terminal";

interface RenderedTerminalOutput {
  text: string;
  dynamicFrames: string[];
}

interface MessageResponder {
  replyText(chatId: string, text: string): Promise<void>;
  replyImage(chatId: string, imageBase64: string): Promise<void>;
  replyAudio?(
    chatId: string,
    audioBase64: string,
    fileName?: string,
    mimeType?: string,
  ): Promise<void>;
  replyFile?(
    chatId: string,
    fileBase64: string,
    fileName: string,
    mimeType?: string,
  ): Promise<void>;
  replyTextWithMeta?(chatId: string, text: string): Promise<{ messageId?: string }>;
  deleteMessage?(messageId: string): Promise<void>;
  startStreamingCard?(chatId: string): Promise<void>;
  updateStreamingCard?(chatId: string, text: string): Promise<void>;
  finishStreamingCard?(chatId: string, finalText?: string): Promise<void>;
}

interface BridgeInboundAttachment {
  messageType: string;
  fileName: string;
  mimeType: string;
  contentBase64: string;
  sourceFileKey?: string;
}

interface OpenClawBridgeMediaItem {
  kind: "image" | "file";
  fileName: string;
  mimeType: string;
  contentBase64: string;
  source: string;
}

interface OpenClawBridgeResponse {
  text: string;
  media: OpenClawBridgeMediaItem[];
  audioAsVoice: boolean;
}

interface OpenClawBridgeStreamCallbacks {
  onDeltaText?: (text: string) => void | Promise<void>;
}

interface HistorySeedEntry {
  role: "user" | "assistant" | "system";
  content: string;
}

interface FeishuMentionEntry {
  key: string;
  name: string;
  openId: string;
  userId: string;
}

interface FeishuAtTagEntry {
  key: string;
  id: string;
  name: string;
}

interface InboundTextContext {
  channel: ChannelName;
  chatId: string;
  chatType: string;
  isMentioned: boolean;
  hasAnyMention?: boolean;
  botOpenId?: string;
  senderId?: string;
  senderOpenId?: string;
  senderUserId?: string;
  senderName?: string;
  mentions?: FeishuMentionEntry[];
  messageId?: string;
  eventId?: string;
  messageType: string;
  contentRaw: string;
  contentObj: Record<string, unknown>;
  attachments?: BridgeInboundAttachment[];
  text: string;
  llmText: string;
  rawEvent: Record<string, unknown>;
  allowFrom: string[];
  responder: MessageResponder;
}

interface NexChatBridgeRequest {
  source: "tfclaw_feishu_gateway";
  channel: ChannelName;
  selectionKey: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  senderUserId?: string;
  messageId?: string;
  eventId?: string;
  messageType: string;
  text: string;
  contentRaw: string;
  contentObj: Record<string, unknown>;
  feishuEvent: Record<string, unknown>;
  historySeed?: HistorySeedEntry[];
}

interface OpenClawBridgeRequest {
  source: "tfclaw_feishu_gateway";
  channel: ChannelName;
  selectionKey: string;
  chatId: string;
  chatType?: string;
  isMentioned?: boolean;
  hasAnyMention?: boolean;
  botOpenId?: string;
  senderId?: string;
  senderOpenId?: string;
  senderUserId?: string;
  senderName?: string;
  messageId?: string;
  eventId?: string;
  messageType: string;
  contentRaw?: string;
  contentObj?: Record<string, unknown>;
  feishuEvent?: Record<string, unknown>;
  messageThreadId?: string | number;
  replyToId?: string;
  rootMessageId?: string;
  timestamp?: number;
  text: string;
  historySeed?: HistorySeedEntry[];
  attachments?: BridgeInboundAttachment[];
  routingUserKey?: string;
  requesterSenderId?: string;
  workspaceOverrideDir?: string;
  allowEmptyMediaPlaceholderFallback?: boolean;
}

interface TerminalProgressSession {
  selectionKey: string;
  chatId: string;
  terminalId: string;
  responder: MessageResponder;
  timer: NodeJS.Timeout;
  lastSnapshot: string;
  lastChangedAt: number;
  startedAt: number;
  busy: boolean;
  lastProgressMessageId?: string;
}

interface CommandProgressSession {
  requestId: string;
  selectionKey: string;
  chatId: string;
  responder: MessageResponder;
  queue: Promise<void>;
  lastProgressMessageId?: string;
  lastProgressBody?: string;
}

type TfclawUserRole = "super_root" | "admin" | "user";

interface TfclawAccessGroup {
  name: string;
  displayName: string;
  scopeUserKey: string;
  workspaceDir: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
}

interface TfclawUserProfile {
  displayName: string;
  updatedAt: string;
}

interface TfclawAccessStateFile {
  version: 1;
  superRootUserKey?: string;
  admins: string[];
  groups: Record<string, TfclawAccessGroup>;
  aliases: Record<string, string>;
  userProfiles: Record<string, TfclawUserProfile>;
}

interface OpenClawRouteScope {
  kind: "personal" | "group";
  modeLabel: string;
  routingUserKey: string;
  workspaceOverrideDir?: string;
}

interface RouterUserScope {
  senderKey: string;
  userKey: string;
  linuxUser: string;
  actorRole: TfclawUserRole;
  tmuxSessionKey: string;
}

interface ChatApp {
  readonly name: ChannelName;
  readonly enabled: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
}

function randomId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function resolveSenderUserKey(value: {
  senderOpenId?: string;
  senderUserId?: string;
  senderId?: string;
  routingUserKey?: string;
}): string {
  return (value.routingUserKey || value.senderOpenId || value.senderUserId || value.senderId || "").trim();
}

function sanitizeTmuxName(name: string): string {
  return name
    .trim()
    .replace(/[^\w-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 64);
}

const REALTIME_FOREGROUND_COMMANDS = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "tsx",
  "ts-node",
]);

const TMUX_SHORT_ALIAS_COMMANDS = new Set([
  "/thelp",
  "/tstatus",
  "/tsessions",
  "/tpanes",
  "/tnew",
  "/ttarget",
  "/tclose",
  "/tsocket",
  "/tlines",
  "/twait",
  "/tstream",
  "/tcapture",
  "/tkey",
  "/tsend",
]);

const TFCLAW_SLASH_COMMAND_ALIAS_TO_LEGACY: Record<string, string> = {
  "/tfhelp": "/help",
  "/tfstate": "/state",
  "/tflist": "/list",
  "/tfnew": "/new",
  "/tfcapture": "/capture",
  "/tfattach": "/attach",
  "/tfkey": "/key",
  "/tfctrlc": "/ctrlc",
  "/tfctrld": "/ctrld",
  "/tfuse": "/use",
  "/tfclose": "/close",
};

const TFCLAW_MANAGED_SLASH_COMMANDS = new Set([
  "tf",
  "tmux",
  "passthrough",
  "pt",
  "thelp",
  "tstatus",
  "tsessions",
  "tpanes",
  "tnew",
  "ttarget",
  "tclose",
  "tsocket",
  "tlines",
  "twait",
  "tstream",
  "tcapture",
  "tkey",
  "tsend",
  "tfhelp",
  "tfstate",
  "tflist",
  "tfnew",
  "tfcapture",
  "tfattach",
  "tfkey",
  "tfctrlc",
  "tfctrld",
  "tfuse",
  "tfclose",
  "tfapikey",
  "tfenv",
  "tfroot",
  "tfadmin",
  "tfusers",
  "tfgroup",
  "tfmode",
]);

const TFCLAW_GROUP_CHAT_SCOPE_PREFIX = "group-chat:";
const OPENCLAW_GATEWAY_DEVICE_AUTH_ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

interface OpenClawGatewayOperatorIdentity {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function encodeBase64Url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function deriveEd25519PublicKeyRawFromPem(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === OPENCLAW_GATEWAY_DEVICE_AUTH_ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, OPENCLAW_GATEWAY_DEVICE_AUTH_ED25519_SPKI_PREFIX.length)
      .equals(OPENCLAW_GATEWAY_DEVICE_AUTH_ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(OPENCLAW_GATEWAY_DEVICE_AUTH_ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function normalizeDeviceMetadataForAuth(value?: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : "";
}

function buildGatewayDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
  platform?: string;
  deviceFamily?: string;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily),
  ].join("|");
}

function resolvePathFromBase(rawPath: string, baseDir: string, options?: { allowEmpty?: boolean }): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return options?.allowEmpty ? "" : path.resolve(baseDir);
  }
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed === "~" ? "." : trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return path.resolve(baseDir, trimmed);
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

const COMMAND_RESULT_TIMEOUT_MS = Math.max(
  1000,
  Math.min(24 * 60 * 60 * 1000, toNumber(process.env.TFCLAW_COMMAND_RESULT_TIMEOUT_MS, 24 * 60 * 60 * 1000)),
);
const FEISHU_ACK_REACTION = toString(process.env.TFCLAW_FEISHU_ACK_REACTION, "OnIt").trim() || "OnIt";
const FEISHU_ACK_REACTION_ENABLED = toBoolean(process.env.TFCLAW_FEISHU_ACK_REACTION_ENABLED, true);
const FEISHU_DEBUG_INBOUND = toBoolean(process.env.TFCLAW_FEISHU_DEBUG_INBOUND, false);

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
      return false;
    }
  }
  return fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return parseCsv(value);
  }
  return fallback;
}

function normalizeLeadingCommandSlash(text: string): string {
  const leadingSpaces = text.match(/^\s*/)?.[0] ?? "";
  const rest = text.slice(leadingSpaces.length);
  if (rest.startsWith("／")) {
    return `${leadingSpaces}/${rest.slice(1)}`;
  }
  return text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingFeishuMentions(text: string, mentionKeys: string[]): string {
  let current = text;
  const normalizedKeys = mentionKeys
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  let changed = true;
  while (changed) {
    changed = false;
    const trimmedStart = current.trimStart();

    // remove explicit <at ...>...</at> prefixes
    const atTag = trimmedStart.match(/^<at\b[^>]*>[\s\S]*?<\/at>\s*/i);
    if (atTag) {
      current = trimmedStart.slice(atTag[0].length);
      changed = true;
      continue;
    }

    // remove mention keys emitted by Feishu, e.g. @_user_1
    const matchedKey = normalizedKeys.find((key) => trimmedStart.startsWith(key));
    if (matchedKey) {
      current = trimmedStart.slice(matchedKey.length).trimStart();
      changed = true;
    }
  }

  return current;
}

function normalizeFeishuInboundText(rawText: string, mentionKeys: string[]): string {
  const noInvisible = rawText.replace(/\u200b/g, " ");
  const withoutMentions = stripLeadingFeishuMentions(noInvisible, mentionKeys);
  return normalizeLeadingCommandSlash(withoutMentions).trim();
}

function parseFeishuInboundMessageText(
  rawContent: string,
  messageType: string,
  contentObj: Record<string, unknown>,
): string {
  const normalizedType = messageType.trim().toLowerCase();
  if (normalizedType === "post") {
    return parseFeishuPostContent(contentObj).textContent;
  }
  if (normalizedType === "text") {
    return toString(contentObj.text).trim();
  }
  if (normalizedType === "share_chat") {
    const body = toString(contentObj.body).trim();
    if (body) {
      return body;
    }
    const summary = toString(contentObj.summary).trim();
    if (summary) {
      return summary;
    }
    const shareChatId = toString(contentObj.share_chat_id).trim();
    if (shareChatId) {
      return `[Forwarded message: ${shareChatId}]`;
    }
    return "[Forwarded message]";
  }
  if (normalizedType === "merge_forward") {
    return "[Merged and Forwarded Message - loading...]";
  }
  return rawContent.trim();
}

function checkFeishuBotMentionedLikeOpenClaw(
  rawContent: string,
  messageType: string,
  contentObj: Record<string, unknown>,
  mentions: FeishuMentionEntry[],
  botOpenId: string,
  botName: string,
): boolean {
  const normalizedBotOpenId = botOpenId.trim();
  if (!normalizedBotOpenId) {
    return false;
  }
  if (mentions.length > 0) {
    for (const mention of mentions) {
      if (mention.openId !== normalizedBotOpenId) {
        continue;
      }
      if (botName.trim() && mention.name.trim() && mention.name.trim() !== botName.trim()) {
        continue;
      }
      return true;
    }
  }
  if (messageType.trim().toLowerCase() === "post") {
    const parsed = parseFeishuPostContent(contentObj);
    return parsed.mentionedIds.some((id) => id === normalizedBotOpenId);
  }
  return false;
}

function normalizeFeishuMentionsLikeOpenClaw(
  text: string,
  mentions?: FeishuMentionEntry[],
  botStripId?: string,
): string {
  if (!mentions || mentions.length === 0) {
    return text;
  }
  let result = text;
  const escapedBotStripId = botStripId?.trim() || "";
  for (const mention of mentions) {
    const key = mention.key.trim();
    if (!key) {
      continue;
    }
    const safeKey = escapeRegExp(key);
    const escapedName = mention.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const replacement = escapedBotStripId && mention.openId === escapedBotStripId
      ? ""
      : mention.openId
        ? `<at user_id="${mention.openId}">${escapedName}</at>`
        : `@${mention.name}`;
    result = result.replace(new RegExp(safeKey, "g"), () => replacement).trim();
  }
  return result;
}

function isInternalFeishuMediaPlaceholderText(text: string): boolean {
  const normalized = toString(text).trim();
  if (!normalized) {
    return false;
  }
  const compact = normalized.replace(/\s+/g, " ");
  return /(?:^|[\s:])(?:MEDIA|附件|attachment|file|media)\s*[:：]?\s*(?:file:\/\/)?\/tmp\/openclaw-\d+\//i.test(compact)
    || /(?:^|\s)📎\s*(?:MEDIA\s*[:：]?\s*)?(?:file:\/\/)?\/tmp\/openclaw-\d+\//i.test(compact);
}

function extractFeishuInlineMentionKeys(rawText: string): string[] {
  if (!rawText) {
    return [];
  }
  const matches = rawText.match(/@_user_\d+/g) ?? [];
  return Array.from(new Set(matches.map((item) => item.trim()).filter(Boolean)));
}

function decodeHtmlEntity(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractFeishuAtTags(rawText: string): FeishuAtTagEntry[] {
  if (!rawText) {
    return [];
  }

  const results: FeishuAtTagEntry[] = [];
  const seen = new Set<string>();
  const pattern = /<at\b([^>]*)>([\s\S]*?)<\/at>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rawText)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";

    let id = "";
    let key = "";
    const attrPattern = /([a-zA-Z_][\w:-]*)\s*=\s*(['"])(.*?)\2/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(attrs)) !== null) {
      const name = (attrMatch[1] ?? "").trim().toLowerCase();
      const value = decodeHtmlEntity((attrMatch[3] ?? "").trim());
      if (!value) {
        continue;
      }
      if (name === "user_id" || name === "open_id" || name === "id") {
        id = value;
      }
      if (name === "key" || name === "mention_key") {
        key = value;
      }
    }

    const name = decodeHtmlEntity(body.replace(/<[^>]*>/g, "").trim());
    const dedupKey = `${key}|${id}|${name}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    results.push({ key, id, name });
  }

  return results;
}

function extractFeishuMentions(messageObj: Record<string, unknown>, contentObj: Record<string, unknown>): FeishuMentionEntry[] {
  const mentions: FeishuMentionEntry[] = [];
  const seen = new Set<string>();
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      const mentionObj = toObject(item);
      const mentionIdObj = toObject(mentionObj.id);
      const key = toString(mentionObj.key).trim();
      const name = toString(mentionObj.name, toString(mentionObj.user_name)).trim();
      const openId = toString(mentionIdObj.open_id, toString(mentionObj.open_id)).trim();
      const userId = toString(mentionIdObj.user_id, toString(mentionObj.user_id)).trim();
      if (!key && !name && !openId && !userId) {
        continue;
      }
      const dedupKey = `${key}|${name}|${openId}|${userId}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      mentions.push({
        key,
        name,
        openId,
        userId,
      });
    }
  };
  collect(messageObj.mentions);
  collect(contentObj.mentions);
  return mentions;
}

function mentionKeys(entries: FeishuMentionEntry[]): string[] {
  return entries
    .map((entry) => entry.key.trim())
    .filter(Boolean);
}

function isFeishuMessageMentionedToBot(
  entries: FeishuMentionEntry[],
  botOpenId: string,
  botName: string,
  appId: string,
  options?: {
    atTags?: FeishuAtTagEntry[];
    mentionKeys?: string[];
  },
): boolean {
  const atTags = options?.atTags ?? [];
  const inlineMentionKeys = options?.mentionKeys ?? [];
  if (entries.length === 0) {
    if (atTags.length === 0) {
      const hasFallbackInlineMention = inlineMentionKeys.length === 1 && inlineMentionKeys[0] === "@_user_0";
      if (!botOpenId.trim() && !botName.trim() && hasFallbackInlineMention) {
        return true;
      }
      return false;
    }
  }

  const normalizedBotOpenId = botOpenId.trim();
  const normalizedBotName = botName.trim();
  const normalizedAppId = appId.trim();
  for (const entry of entries) {
    if (normalizedBotOpenId && (entry.openId === normalizedBotOpenId || entry.userId === normalizedBotOpenId)) {
      return true;
    }
    if (normalizedBotName && entry.name && (entry.name === normalizedBotName || entry.name.includes(normalizedBotName))) {
      return true;
    }
    if (normalizedAppId && (entry.openId === normalizedAppId || entry.userId === normalizedAppId)) {
      return true;
    }
  }

  for (const entry of atTags) {
    const atId = entry.id.trim();
    if (normalizedBotOpenId && atId === normalizedBotOpenId) {
      return true;
    }
    if (normalizedAppId && atId === normalizedAppId) {
      return true;
    }
    if (normalizedBotName && entry.name && (entry.name === normalizedBotName || entry.name.includes(normalizedBotName))) {
      return true;
    }
  }

  if (!normalizedBotOpenId && !normalizedBotName && entries.length === 1 && entries[0]?.key === "@_user_0") {
    return true;
  }
  if (!normalizedBotOpenId && !normalizedBotName && atTags.length === 1) {
    return true;
  }

  return false;
}

function replaceFeishuMentionTokens(
  rawText: string,
  entries: FeishuMentionEntry[],
  botOpenId: string,
  botName: string,
): string {
  let output = rawText.replace(/\u200b/g, " ").replace(/@_all/g, "@全体成员");
  const normalizedBotOpenId = botOpenId.trim();
  const normalizedBotName = botName.trim();

  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) {
      continue;
    }
    const isBotMention =
      (normalizedBotOpenId.length > 0 && (entry.openId === normalizedBotOpenId || entry.userId === normalizedBotOpenId))
      || (normalizedBotName.length > 0 && entry.name.length > 0
        && (entry.name === normalizedBotName || entry.name.includes(normalizedBotName)));
    if (isBotMention) {
      output = output.replace(new RegExp(`${escapeRegExp(key)}\\s*`, "g"), "");
      continue;
    }
    if (entry.name) {
      output = output.split(key).join(`@${entry.name}`);
    }
  }

  return output
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .trim();
}

interface FeishuPostMediaKeyEntry {
  fileKey: string;
  fileName: string;
}

interface FeishuPostParseResult {
  textContent: string;
  imageKeys: string[];
  mediaKeys: FeishuPostMediaKeyEntry[];
  mentionedIds: string[];
}

function resolveFeishuPostPayload(contentObj: Record<string, unknown>): Record<string, unknown> | undefined {
  const directContent = contentObj.content;
  if (Array.isArray(directContent)) {
    return contentObj;
  }

  const postObj = toObject(contentObj.post);
  if (Array.isArray(postObj.content)) {
    return postObj;
  }
  for (const value of Object.values(postObj)) {
    const candidate = toObject(value);
    if (Array.isArray(candidate.content)) {
      return candidate;
    }
  }

  for (const value of Object.values(contentObj)) {
    const candidate = toObject(value);
    if (Array.isArray(candidate.content)) {
      return candidate;
    }
  }
  return undefined;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function parseFeishuPostContent(contentObj: Record<string, unknown>): FeishuPostParseResult {
  const payload = resolveFeishuPostPayload(contentObj);
  if (!payload) {
    return {
      textContent: "[富文本消息]",
      imageKeys: [],
      mediaKeys: [],
      mentionedIds: [],
    };
  }

  const paragraphs = Array.isArray(payload.content) ? payload.content : [];
  const textLines: string[] = [];
  const imageKeys: string[] = [];
  const mediaKeys: FeishuPostMediaKeyEntry[] = [];
  const mentionedIds: string[] = [];

  const title = toString(payload.title).trim();
  if (title) {
    textLines.push(title);
  }

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const parts: string[] = [];
    for (const element of paragraph) {
      const item = toObject(element);
      const tag = toString(item.tag).trim().toLowerCase();
      if (!tag) {
        continue;
      }
      if (tag === "text") {
        const text = toString(item.text).trim();
        if (text) {
          parts.push(text);
        }
        continue;
      }
      if (tag === "a") {
        const label = toString(item.text).trim();
        const href = toString(item.href).trim();
        if (label && href) {
          parts.push(`${label}: ${href}`);
        } else if (label) {
          parts.push(label);
        } else if (href) {
          parts.push(href);
        }
        continue;
      }
      if (tag === "at") {
        const mentionName = toString(item.user_name, toString(item.text)).trim();
        const mentionId = toString(item.open_id, toString(item.user_id)).trim();
        if (mentionName) {
          parts.push(`@${mentionName}`);
        }
        if (mentionId) {
          mentionedIds.push(mentionId);
        }
        continue;
      }
      if (tag === "img") {
        const imageKey = toString(item.image_key).trim();
        if (imageKey) {
          imageKeys.push(imageKey);
        }
        parts.push("[图片]");
        continue;
      }
      if (tag === "media") {
        const fileKey = toString(item.file_key).trim();
        const fileName = toString(item.file_name, "[媒体文件]").trim() || "[媒体文件]";
        if (fileKey) {
          mediaKeys.push({
            fileKey,
            fileName,
          });
        }
        parts.push(`[媒体] ${fileName}`);
        continue;
      }
      if (tag === "emotion") {
        const emoji = toString(item.emoji, toString(item.text, toString(item.emoji_type))).trim();
        if (emoji) {
          parts.push(emoji);
        }
        continue;
      }
      if (tag === "code" || tag === "code_block" || tag === "pre") {
        const code = toString(item.text, toString(item.content)).trim();
        if (code) {
          parts.push(code);
        }
        continue;
      }
      if (tag === "br") {
        parts.push("\n");
      }
    }
    const line = parts.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    if (line) {
      textLines.push(line);
    }
  }

  return {
    textContent: textLines.join("\n").trim() || "[富文本消息]",
    imageKeys: dedupeStrings(imageKeys),
    mediaKeys: Array.from(
      new Map(
        mediaKeys
          .filter((entry) => entry.fileKey.trim())
          .map((entry) => [entry.fileKey.trim(), { fileKey: entry.fileKey.trim(), fileName: entry.fileName }]),
      ).values(),
    ),
    mentionedIds: dedupeStrings(mentionedIds),
  };
}

function buildFeishuResourceHint(messageType: string, contentObj: Record<string, unknown>, messageId: string): string {
  const normalizedType = messageType.trim().toLowerCase();
  if (normalizedType === "post") {
    const parsedPost = parseFeishuPostContent(contentObj);
    const parts = [
      "[附件待取] 类型: post",
      `message_id: ${messageId || "unknown"}`,
      `内嵌图片数: ${parsedPost.imageKeys.length}`,
      `内嵌媒体数: ${parsedPost.mediaKeys.length}`,
    ];
    if (parsedPost.imageKeys.length > 0) {
      parts.push(`image_keys: ${parsedPost.imageKeys.join(",")}`);
    }
    if (parsedPost.mediaKeys.length > 0) {
      parts.push(`media_file_keys: ${parsedPost.mediaKeys.map((entry) => entry.fileKey).join(",")}`);
    }
    parts.push("下载提示: 调用 download_message_resource 获取并解析内容");
    return parts.join(" | ");
  }

  if (!["image", "file", "media", "video", "audio", "sticker"].includes(normalizedType)) {
    return "";
  }

  let fileKey = "";
  let name = "";
  if (normalizedType === "image") {
    fileKey = toString(contentObj.image_key).trim();
    name = toString(contentObj.image_name, `image_${messageId || "unknown"}.png`).trim();
  } else if (normalizedType === "sticker") {
    fileKey = toString(contentObj.file_key, toString(contentObj.media_id)).trim();
    name = toString(contentObj.file_name, `sticker_${messageId || "unknown"}.webp`).trim();
  } else {
    fileKey = toString(contentObj.file_key, toString(contentObj.media_id)).trim();
    name = toString(contentObj.file_name, toString(contentObj.file, `${normalizedType}_${messageId || "unknown"}`)).trim();
  }

  const parts = [
    `[附件待取] 类型: ${normalizedType}`,
    `文件名: ${name || "未命名"}`,
    `message_id: ${messageId || "unknown"}`,
  ];
  if (fileKey) {
    parts.push(`file_key: ${fileKey}`);
  }
  parts.push("下载提示: 调用 download_message_resource 获取并解析内容");
  return parts.join(" | ");
}

function buildFeishuNonTextBaseText(
  messageType: string,
  contentObj: Record<string, unknown>,
  messageId: string,
): string {
  const normalizedType = messageType.trim().toLowerCase();
  if (normalizedType === "post") {
    const parsedPost = parseFeishuPostContent(contentObj);
    const resourceHint = buildFeishuResourceHint(normalizedType, contentObj, messageId);
    return [parsedPost.textContent, resourceHint].filter(Boolean).join("\n\n").trim();
  }

  if (normalizedType === "share_chat") {
    const body = toString(contentObj.body).trim();
    const summary = toString(contentObj.summary).trim();
    const shareChatId = toString(contentObj.share_chat_id).trim();
    const lines = [
      "[转发会话消息]",
      body || summary ? `内容: ${body || summary}` : "",
      shareChatId ? `share_chat_id: ${shareChatId}` : "",
    ].filter(Boolean);
    return lines.join("\n").trim();
  }

  if (normalizedType === "merge_forward") {
    return "[合并转发消息] 已收到 merge_forward 消息。";
  }

  if (normalizedType === "share_user") {
    const userName = toString(contentObj.user_name, toString(contentObj.name)).trim();
    const userId = toString(contentObj.user_id, toString(contentObj.open_id)).trim();
    const lines = [
      "[分享联系人消息]",
      userName ? `用户名: ${userName}` : "",
      userId ? `用户ID: ${userId}` : "",
    ].filter(Boolean);
    return lines.join("\n").trim();
  }

  const resourceHint = buildFeishuResourceHint(normalizedType, contentObj, messageId);
  if (resourceHint) {
    return resourceHint;
  }

  const fallback = toString(contentObj.text, toString(contentObj.content)).trim();
  if (fallback) {
    return fallback;
  }
  return `[非文本消息] 类型: ${normalizedType || "unknown"}`;
}

const FEISHU_LINK_RE = /https?:\/\/[^\s<>"'`]+/g;
const FEISHU_DOC_LINK_PATH_MARKERS = [
  "/docx/",
  "/doc/",
  "/wiki/",
  "/base/",
  "/sheet/",
  "/sheets/",
  "/bitable/",
];
const FEISHU_DOC_INTENT_RE = /(?:飞书文档|云文档|知识库|docx|wiki|bitable|新建(?:一个)?文档|创建(?:一个)?文档|写入(?:到)?文档|追加(?:到)?文档)/i;

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[),.;!?，。；！？、]+$/g, "");
}

function extractFeishuDocLinks(text: string): string[] {
  if (!text) {
    return [];
  }

  const matches = text.match(FEISHU_LINK_RE) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const candidate = trimTrailingPunctuation(raw.trim());
    if (!candidate) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const host = parsed.hostname.trim().toLowerCase();
    if (!host) {
      continue;
    }
    const isFeishuHost =
      host.endsWith(".feishu.cn")
      || host === "feishu.cn"
      || host.endsWith(".larksuite.com")
      || host === "larksuite.com";
    if (!isFeishuHost) {
      continue;
    }
    const pathName = parsed.pathname.trim().toLowerCase();
    const hasDocMarker = FEISHU_DOC_LINK_PATH_MARKERS.some((marker) => pathName.includes(marker));
    if (!hasDocMarker) {
      continue;
    }
    const normalized = parsed.toString();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function buildFeishuDocToolHint(text: string): string {
  const links = extractFeishuDocLinks(text);
  const hasDocIntent = FEISHU_DOC_INTENT_RE.test(text || "");
  if (!hasDocIntent && links.length === 0) {
    return "";
  }
  const lines: string[] = [
    hasDocIntent
      ? "[系统提示] 检测到飞书文档相关意图。请优先调用内置 Feishu 工具处理，不要手写临时 HTTP 脚本。"
      : "[系统提示] 检测到飞书文档/知识库链接。请优先调用内置 Feishu 工具读取链接内容后再回答。",
    "[可用工具]",
    "- feishu_doc",
    "- feishu_wiki",
    "- feishu_drive",
    "- feishu_bitable",
  ];
  if (links.length > 0) {
    lines.push("[链接列表]");
    lines.push(...links.map((link, idx) => `${idx + 1}. ${link}`));
  }
  return lines.join("\n");
}

function mergeNoProxyHosts(hosts: string[]): void {
  const existing = `${process.env.NO_PROXY ?? process.env.no_proxy ?? ""}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...existing, ...hosts.map((item) => item.trim()).filter(Boolean)]));
  const value = merged.join(",");
  process.env.NO_PROXY = value;
  process.env.no_proxy = value;
}

function hostFromUrl(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return "";
  }
  try {
    return new URL(text).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}

function isLocalNoProxyHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "0.0.0.0";
}

function isAnsiCsiFinal(ch: string | undefined): boolean {
  if (!ch) {
    return false;
  }
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_C1_CSI_RE = /\u009b[0-?]*[ -/]*[@-~]/g;
const ANSI_SGR_FRAGMENT_RE = /\[(?:\d{1,3};?){1,12}[A-Za-z]/g;
const ANSI_FRAGMENT_RE = /\[(?:\?|:|;|\d){1,20}[ -/]*[@-~]/g;

function trimRenderedLine(line: string): string {
  return line
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_C1_CSI_RE, "")
    .replace(ANSI_SGR_FRAGMENT_RE, "")
    .replace(ANSI_FRAGMENT_RE, "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trimEnd();
}

function describeSdkError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const errorObj = toObject(error);
  const response = toObject((errorObj.response as unknown) ?? {});
  const status = toNumber(response.status, 0);
  const dataRaw = response.data;
  const dataObj = toObject(dataRaw);

  const code = toString(dataObj.code) || toString(errorObj.code);
  const msg = toString(dataObj.msg) || toString(errorObj.msg);

  const parts: string[] = [base];
  if (status > 0) {
    parts.push(`http=${status}`);
  }
  if (code) {
    parts.push(`code=${code}`);
  }
  if (msg) {
    parts.push(`msg=${msg}`);
  }

  if (!msg || !code) {
    try {
      const raw = typeof dataRaw === "string" ? dataRaw : JSON.stringify(dataRaw);
      if (raw) {
        parts.push(`data=${raw.slice(0, 400)}`);
      }
    } catch {
      // ignore stringify failures
    }
  }

  return parts.join(" | ");
}

function joinHttpUrl(baseUrl: string, pathValue: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const pathPart = pathValue.trim();
  if (!base) {
    return pathPart;
  }
  if (!pathPart) {
    return base;
  }
  if (pathPart.startsWith("http://") || pathPart.startsWith("https://")) {
    return pathPart;
  }
  return `${base}/${pathPart.replace(/^\/+/, "")}`;
}

class NexChatBridgeClient {
  readonly enabled: boolean;

  constructor(private readonly config: NexChatBotConfig) {
    this.enabled = config.enabled && config.baseUrl.trim().length > 0;
  }

  private endpointUrl(): string {
    return joinHttpUrl(this.config.baseUrl, this.config.runPath);
  }

  async run(request: NexChatBridgeRequest): Promise<string> {
    if (!this.enabled) {
      throw new Error("nexchatbot bridge is disabled");
    }

    const timeoutMs = Math.max(1000, this.config.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const apiKey = this.config.apiKey.trim();
      if (apiKey) {
        headers["x-api-key"] = apiKey;
        headers.authorization = `Bearer ${apiKey}`;
      }

      const response = await fetch(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const responseText = await response.text();

      let payload: Record<string, unknown> = {};
      if (responseText) {
        try {
          payload = toObject(JSON.parse(responseText));
        } catch {
          payload = {};
        }
      }

      if (!response.ok) {
        const detail = toString(payload.detail) || toString(payload.error) || responseText.slice(0, 300);
        throw new Error(`http ${response.status}: ${detail || response.statusText}`);
      }

      const status = toString(payload.status).trim().toLowerCase();
      if (status && status !== "ok") {
        const detail = toString(payload.error) || toString(payload.detail) || "unknown error";
        throw new Error(`bridge status=${status}: ${detail}`);
      }

      const reply = toString(payload.reply).trim();
      if (reply) {
        return reply;
      }

      const detail = toString(payload.error) || toString(payload.detail);
      if (detail) {
        throw new Error(detail);
      }
      return "(nexchatbot returned empty reply)";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface CommandRunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

interface LinuxUserAccount {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

interface OpenClawUserBinding {
  linuxUser: string;
  gatewayPort: number;
  gatewayToken: string;
  createdAt: string;
  updatedAt: string;
}

interface OpenClawUserMapFile {
  version: 1;
  users: Record<string, OpenClawUserBinding>;
}

interface OpenClawResolvedUserBinding extends OpenClawUserBinding {
  userKey: string;
  account: LinuxUserAccount;
}

interface OpenClawExecutionScope {
  userKey: string;
  linuxUser: string;
  homeDir: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const OPENCLAW_BRIDGE_COMPACTION_RESERVE_TOKENS_FLOOR = 20000;
const OPENCLAW_BRIDGE_WORKDIR_CONST_NAME = "TFCLAW_USER_WORKDIR";
const OPENCLAW_BRIDGE_WORKDIR_SEPARATOR = "——————————————————————";
const OPENCLAW_BRIDGE_WORKSPACE_ENV_FILE_NAME = ".env";
const OPENCLAW_BRIDGE_LEGACY_USER_ENV_FILE_NAME = "user.env.json";
const OPENCLAW_BRIDGE_WORKSPACE_SEED_MARKER_NAME = ".tfclaw-workspace.seeded.json";
const OPENCLAW_BRIDGE_COMMON_WORKSPACE_DIR_NAME = "commonworkspace";
const OPENCLAW_BRIDGE_WORKSPACE_TEMPLATE_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;
const OPENCLAW_BRIDGE_WORKSPACE_SEED_ALLOWED_EXISTING_ENTRIES = new Set<string>([
  OPENCLAW_BRIDGE_WORKSPACE_ENV_FILE_NAME,
  "skills",
  "WORKDIR.const.js",
  ".npm-cache",
  ".npm-global",
  ".npmrc",
  OPENCLAW_BRIDGE_WORKSPACE_SEED_MARKER_NAME,
]);
const OPENCLAW_BRIDGE_ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH = 16 * 1024;
const OPENCLAW_BRIDGE_INBOUND_MAX_FILE_BYTES = 30 * 1024 * 1024;
const OPENCLAW_BRIDGE_OUTBOUND_MAX_FILE_BYTES = 30 * 1024 * 1024;
const OPENCLAW_BRIDGE_MEDIA_FETCH_TIMEOUT_MS = 20_000;
const FEISHU_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FEISHU_MAX_FILE_BYTES = 30 * 1024 * 1024;
const FEISHU_TEXT_CHUNK_LIMIT = 4000;
const FEISHU_STREAMING_CARD_UPDATE_THROTTLE_MS = 120;
const FEISHU_AUDIO_TRANSCODE_TIMEOUT_MS = 30_000;
const OPENCLAW_BRIDGE_HEURISTIC_ATTACHMENT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
  ".mp3",
  ".wav",
  ".ogg",
  ".opus",
  ".m4a",
  ".aac",
  ".flac",
  ".amr",
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".7z",
  ".bin",
]);
const FEISHU_WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);
const OPENCLAW_BUILTIN_SLASH_COMMANDS = new Set([
  "help",
  "commands",
  "status",
  "context",
  "compact",
  "usage",
  "model",
  "reset",
  "new",
  "think",
  "verbose",
  "reasoning",
  "elevated",
  "exec",
  "skill",
  "whoami",
  "approve",
  "allowlist",
  "config",
  "debug",
  "restart",
  "stop",
  "queue",
  "tts",
]);

class OpenClawPerUserBridge {
  readonly enabled: boolean;

  private readonly mapFilePath: string;
  private readonly openclawEntryPath: string;

  private readonly gatewayOperatorIdentityByCacheKey = new Map<string, OpenClawGatewayOperatorIdentity>();
  private readonly distEntryCandidates: string[];

  private mapLock: Promise<void> = Promise.resolve();
  private runAsModePromise: Promise<"runuser" | "sudo" | "su"> | undefined;
  private distChecked = false;

  constructor(private readonly config: OpenClawBridgeConfig) {
    const root = path.resolve(config.openclawRoot || ".");
    const stateDir = path.resolve(config.stateDir || path.join(process.cwd(), ".runtime", "openclaw_bridge"));
    const sharedEnvPath = path.resolve(config.sharedEnvPath || path.join(stateDir, ".env"));
    const userHomeRoot = path.resolve(config.userHomeRoot || path.join(process.cwd(), ".home"));
    this.config.openclawRoot = root;
    this.config.stateDir = stateDir;
    this.config.sharedEnvPath = sharedEnvPath;
    this.config.userHomeRoot = userHomeRoot;
    this.enabled = config.enabled && root.trim().length > 0;
    this.mapFilePath = path.join(stateDir, "feishu-user-map.json");
    this.openclawEntryPath = path.join(root, "openclaw.mjs");
    this.distEntryCandidates = [
      path.join(root, "dist", "entry.js"),
      path.join(root, "dist", "entry.mjs"),
    ];
  }

  async run(
    request: OpenClawBridgeRequest,
    streamCallbacks?: OpenClawBridgeStreamCallbacks,
  ): Promise<OpenClawBridgeResponse> {
    if (!this.enabled) {
      throw new Error("openclaw bridge is disabled");
    }

    await this.ensureOpenClawEntry();
    const binding = await this.ensureUserBinding(request);
    const runtime = this.prepareUserRuntime(binding, request.workspaceOverrideDir);
    await this.ensureTmuxOpenClawProcess(binding, runtime);

    const attachmentContext = this.stageInboundAttachments(binding, runtime, request.attachments ?? []);
    const channel = (request.channel || "").trim().toLowerCase();
    const slashCommand = this.resolveBuiltinSlashCommand(request.text);
    const prompt = (() => {
      if (slashCommand) {
        return request.text.trim();
      }
      const textWithAttachmentContext = this.injectAttachmentContextIntoText(request.text, attachmentContext);
      const bridgedText = this.buildFeishuInboundPayloadText(request, textWithAttachmentContext);
      return this.composePrompt(
        bridgedText,
        request.historySeed,
        runtime.workspaceConstDeclaration,
      );
    })();
    const gatewaySessionKey = this.resolveGatewaySessionKey(request);
    const runStartedAtMs = Date.now();
    const gatewayUrl = `ws://${this.config.gatewayHost}:${binding.gatewayPort}`;
    const userTempMediaRoot = this.resolveUserTempMediaRoot(binding.account.uid);
    const extraLocalMediaRoots = userTempMediaRoot ? [userTempMediaRoot] : [];
    let reply = await this.callGatewayChat({
      gatewayUrl,
      gatewayToken: binding.gatewayToken,
      sessionKey: gatewaySessionKey,
      message: prompt,
      messageChannel: channel || undefined,
      attachments: attachmentContext.gatewayAttachments,
      workspaceDir: runtime.workspaceDir,
      homeDir: binding.account.home,
      extraLocalMediaRoots,
      requesterSenderId: request.requesterSenderId,
      onDeltaText: streamCallbacks?.onDeltaText,
      allowEmptyMediaPlaceholderFallback: Boolean(request.allowEmptyMediaPlaceholderFallback),
    });
    const voiceRequested = this.hasVoiceReplyIntent(request.text);
    const normalizedReplyText = reply.text.trim();
    const attachmentOnlyReply = this.isAttachmentOnlyText(reply.text);
    if (
      voiceRequested
      && reply.media.length === 0
      && normalizedReplyText
      && !this.isSilentReplyTokenLike(normalizedReplyText)
      && !attachmentOnlyReply
    ) {
      const synthesizedVoice = await this.synthesizeVoiceMediaFromText(binding, runtime.workspaceDir, reply.text);
      if (synthesizedVoice) {
        reply = {
          ...reply,
          media: [synthesizedVoice],
          audioAsVoice: true,
        };
      }
    }
    if (voiceRequested && reply.media.length === 0) {
      const recoveredVoice = await this.resolveRecentVoiceMediaFromWorkspace({
        workspaceDir: runtime.workspaceDir,
        homeDir: binding.account.home,
        runStartedAtMs,
        tempMediaRoot: userTempMediaRoot,
      });
      if (recoveredVoice) {
        reply = {
          ...reply,
          media: [recoveredVoice],
          audioAsVoice: true,
        };
        console.log(
          `[gateway] openclaw voice fallback recovered recent media: ${recoveredVoice.fileName || recoveredVoice.source || "unknown"}`,
        );
      }
    }
    if (
      voiceRequested
      && reply.media.length === 0
      && (
        this.isSilentReplyTokenLike(reply.text.trim())
        || !reply.text.trim()
        || attachmentOnlyReply
      )
    ) {
      const voiceTextFallback = await this.generateVoiceTextFallbackFromGateway(
        gatewayUrl,
        binding.gatewayToken,
        gatewaySessionKey,
        request.text,
        runtime.workspaceDir,
        binding.account.home,
      );
      const deterministicFallback = voiceTextFallback || this.buildDeterministicVoiceFallbackText(request.text);
      if (deterministicFallback) {
        const synthesizedVoice = await this.synthesizeVoiceMediaFromText(
          binding,
          runtime.workspaceDir,
          deterministicFallback,
        );
        if (synthesizedVoice) {
          reply = {
            ...reply,
            media: [synthesizedVoice],
            audioAsVoice: true,
          };
          console.log("[gateway] openclaw voice fallback generated bridge speech text");
        }
      }
    }
    const normalized = reply.text.trim();
    if (!normalized && reply.media.length === 0) {
      return {
        text: this.buildEmptyReplyFallback(reply.text),
        media: [],
        audioAsVoice: false,
      };
    }
    if (this.isSilentReplyTokenLike(normalized)) {
      // Silent reply tokens (and partial fragments like NO_REPL) must never leak
      // to user-facing text. Keep media payloads (e.g. voice-only replies).
      return {
        text: "",
        media: reply.media,
        audioAsVoice: reply.audioAsVoice,
      };
    }
    if (this.isAttachmentOnlyText(normalized) && reply.media.length > 0) {
      // MEDIA placeholder lines are transport directives and should not be shown once media is resolved.
      return {
        text: "",
        media: reply.media,
        audioAsVoice: reply.audioAsVoice,
      };
    }
    return {
      text: normalized,
      media: reply.media,
      audioAsVoice: reply.audioAsVoice,
    };
  }

  private isSilentReplyTokenLike(text: string): boolean {
    const normalized = text.trim().toUpperCase().replace(/\s+/g, "");
    return normalized === "NO"
      || normalized === "NO_"
      || normalized === "NO_R"
      || normalized === "NO_RE"
      || normalized === "NO_REP"
      || normalized === "NO_REPL"
      || normalized === "NO_REPLY";
  }

  private hasVoiceReplyIntent(text: string): boolean {
    const normalized = toString(text).trim();
    if (!normalized) {
      return false;
    }
    return /语音|音频|气泡语音|voice|tts|朗读|播报|念出来|说出来|读出来/i.test(normalized);
  }

  private hasExplicitSharedVoiceSkillRequest(text: string): boolean {
    const normalized = toString(text).trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return /moss[-\s_]?tts[-\s_]?voice|moss[-\s_]?voice[-\s_]?tts/.test(normalized);
  }

  private buildVoiceSkillDirective(text: string): string {
    if (!this.hasExplicitSharedVoiceSkillRequest(text)) {
      return "";
    }
    return [
      "",
      "[Bridge directive]",
      "用户已明确指定共享语音 skill。",
      "本轮禁止调用内置 tts 工具生成最终语音。",
      "优先使用共享技能 moss-tts-voice。",
      "若语音生成失败，不要输出空的 MEDIA 或占位路径；改为返回 1-2 句纯中文祝福正文，交由上层补救。",
    ].join("\n");
  }

  private resolveUserTempMediaRoot(uid: number): string {
    if (!Number.isInteger(uid) || uid <= 0) {
      return "";
    }
    return path.join(os.tmpdir(), `openclaw-${uid}`);
  }

  private isAttachmentOnlyText(text: string): boolean {
    if (!text.trim()) {
      return false;
    }
    const parsed = this.parseMediaDirectivesFromText(text);
    return parsed.mediaRefs.length > 0 && !parsed.text.trim();
  }

  private buildDeterministicVoiceFallbackText(userRequestText: string): string {
    const normalized = toString(userRequestText).trim();
    if (!normalized) {
      return "";
    }
    if (/祝福|祝愿|祝你|恭喜|加油/.test(normalized)) {
      return "祝你今天顺顺利利，心情明朗，好运常在。";
    }
    if (/早安|morning/i.test(normalized)) {
      return "早安，愿你今天元气满满，事事顺心。";
    }
    if (/晚安|night/i.test(normalized)) {
      return "晚安，愿你今晚好梦，明天精神饱满。";
    }
    return "好的，这是语音回复。";
  }

  private async synthesizeVoiceMediaFromText(
    binding: OpenClawResolvedUserBinding,
    workspaceDir: string,
    text: string,
  ): Promise<OpenClawBridgeMediaItem | undefined> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      return undefined;
    }
    const envState = this.loadUserPrivateEnvVars(binding);
    const runtimeEnvVars = this.loadRuntimeEnvVars(binding, workspaceDir, envState.vars);
    const bridgeTtsEnv: Record<string, string> = {
      ...runtimeEnvVars,
      HOME: binding.account.home,
      USER: binding.account.username,
      LOGNAME: binding.account.username,
      OPENCLAW_HOME: binding.account.home,
      CLAWHUB_WORKDIR: workspaceDir,
      TFCLAW_EXEC_WORKSPACE: workspaceDir,
      TFCLAW_EXEC_HOME: binding.account.home,
    };
    const outputDir = path.join(workspaceDir, "outbound");
    fs.mkdirSync(outputDir, { recursive: true });
    // Gateway process may run as root; ensure per-user TTS output directory stays writable by mapped linux user.
    this.ensurePathOwnerAndMode(outputDir, binding.account.uid, binding.account.gid, 0o700);
    const outputPath = path.join(outputDir, `bridge-voice-${Date.now()}.opus`);
    const hasValidOutputPath = (): boolean => {
      try {
        const stat = fs.statSync(outputPath);
        return stat.isFile() && stat.size > 0;
      } catch {
        return false;
      }
    };

    const pythonCommand = await (async (): Promise<string | undefined> => {
      if (await this.commandExists("python3")) {
        return "python3";
      }
      if (await this.commandExists("python")) {
        return "python";
      }
      return undefined;
    })();
    if (!pythonCommand) {
      return undefined;
    }

    const sharedSkillsDir = path.resolve(this.config.sharedSkillsDir || "");
    const sharedMossScriptPath = sharedSkillsDir
      ? path.join(sharedSkillsDir, "moss-tts-voice", "scripts", "tts.py")
      : "";
    const localMossScriptPath = path.join(workspaceDir, "skills", "moss-tts-voice", "scripts", "tts.py");
    const mossScriptCandidates = Array.from(new Set([
      fs.existsSync(localMossScriptPath) ? localMossScriptPath : "",
      sharedMossScriptPath && fs.existsSync(sharedMossScriptPath) ? sharedMossScriptPath : "",
    ])).filter((item) => item.length > 0);
    for (const mossScriptPath of mossScriptCandidates) {
      const tmpWavPath = path.join(outputDir, `bridge-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
      try {
        const mossResult = await this.runAsUser(
          binding.account.username,
          pythonCommand,
          [
            mossScriptPath,
            "--text",
            normalizedText,
            "--voice_id",
            "2001286865130360832",
            "--output",
            tmpWavPath,
          ],
          {
            cwd: path.dirname(mossScriptPath),
            env: bridgeTtsEnv,
            timeoutMs: Math.max(this.config.requestTimeoutMs, 120_000),
          },
        );
        if (mossResult.code !== 0) {
          const detail = mossResult.stderr.trim() || mossResult.stdout.trim() || "unknown error";
          console.warn(`[gateway] openclaw voice fallback moss tts failed (${mossScriptPath}): ${detail}`);
          continue;
        }
        let hasTmpWav = false;
        try {
          hasTmpWav = fs.statSync(tmpWavPath).size > 0;
        } catch {
          hasTmpWav = false;
        }
        if (!hasTmpWav) {
          continue;
        }
        const ffmpegResult = await this.runAsUser(
          binding.account.username,
          "ffmpeg",
          ["-y", "-i", tmpWavPath, "-ac", "1", "-ar", "24000", "-c:a", "libopus", "-b:a", "32k", outputPath],
          {
            cwd: outputDir,
            env: bridgeTtsEnv,
            timeoutMs: Math.max(this.config.requestTimeoutMs, 120_000),
          },
        );
        if (ffmpegResult.code !== 0) {
          const detail = ffmpegResult.stderr.trim() || ffmpegResult.stdout.trim() || "unknown error";
          console.warn(`[gateway] openclaw voice fallback ffmpeg convert failed: ${detail}`);
          continue;
        }
        if (hasValidOutputPath()) {
          break;
        }
      } finally {
        try {
          if (fs.existsSync(tmpWavPath)) {
            fs.unlinkSync(tmpWavPath);
          }
        } catch {
          // no-op
        }
      }
    }
    if (!fs.existsSync(outputPath)) {
      return undefined;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(outputPath);
    } catch {
      stat = undefined;
    }
    if (!stat || !stat.isFile() || stat.size <= 0) {
      return undefined;
    }
    try {
      return await this.loadMediaFromReference(outputPath, {
        workspaceDir,
        homeDir: binding.account.home,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[gateway] openclaw voice fallback media load failed: ${detail}`);
      return undefined;
    }
  }

  private looksLikeAudioFileName(fileName: string): boolean {
    return /\.(?:mp3|wav|ogg|opus|m4a|aac|flac|amr)$/i.test(fileName.trim());
  }

  private async generateVoiceTextFallbackFromGateway(
    gatewayUrl: string,
    gatewayToken: string,
    gatewaySessionKey: string,
    userRequestText: string,
    workspaceDir: string,
    homeDir: string,
  ): Promise<string> {
    const normalizedUserText = userRequestText.trim();
    if (!normalizedUserText) {
      return "";
    }
    const fallbackPrompt = [
      "系统补救任务：上一轮语音发送未成功。",
      "现在禁止调用任何飞书发送工具（尤其是 feishu_chat message/send），不要发送消息。",
      "只输出 1-2 句可用于语音播报的中文回复正文。",
      "禁止输出 NO_REPL、MEDIA:、代码块、解释。",
      `用户原始请求：${normalizedUserText}`,
    ].join("\n");
    try {
      const fallbackReply = await this.callGatewayChat({
        gatewayUrl,
        gatewayToken,
        sessionKey: gatewaySessionKey,
        message: fallbackPrompt,
        workspaceDir,
        homeDir,
        allowEmptyMediaPlaceholderFallback: false,
      });
      const text = fallbackReply.text.trim();
      if (!text || this.isSilentReplyTokenLike(text)) {
        return "";
      }
      return text;
    } catch {
      return "";
    }
  }

  private async resolveRecentVoiceMediaFromWorkspace(options: {
    workspaceDir: string;
    homeDir: string;
    runStartedAtMs: number;
    tempMediaRoot?: string;
  }): Promise<OpenClawBridgeMediaItem | undefined> {
    const candidateRoots = Array.from(
      new Set([
        path.join(options.workspaceDir, "skills", "moss-tts-voice", "outbound"),
        path.join(options.workspaceDir, "outbound"),
        options.tempMediaRoot ? path.resolve(options.tempMediaRoot) : "",
      ]),
    ).filter(Boolean);
    const scanOptions = {
      maxCount: 80,
      maxDirs: 120,
      modifiedAfterMs: Math.max(0, options.runStartedAtMs - 5_000),
      excludeDirNames: [".git", "node_modules"],
    };
    const rankedCandidates = candidateRoots
      .flatMap((rootDir) => this.listRecentFilesUnder(rootDir, scanOptions))
      .map((filePath) => path.resolve(filePath));
    const recentAudioFiles = Array.from(new Set(rankedCandidates))
      .filter((filePath) =>
        this.isPathInsideRoot(filePath, options.workspaceDir)
        || this.isPathInsideRoot(filePath, options.homeDir))
      .filter((filePath) => this.looksLikeAudioFileName(path.basename(filePath)))
      .map((filePath) => {
        try {
          const stat = fs.statSync(filePath);
          return {
            filePath,
            mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
          };
        } catch {
          return undefined;
        }
      })
      .filter((item): item is { filePath: string; mtimeMs: number } => Boolean(item))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((item) => item.filePath);
    for (const candidate of recentAudioFiles) {
      try {
        const media = await this.loadMediaFromReference(candidate, {
          workspaceDir: options.workspaceDir,
          homeDir: options.homeDir,
          extraRoots: options.tempMediaRoot ? [path.resolve(options.tempMediaRoot)] : [],
        });
        const normalizedMime = this.normalizeMimeType(media.mimeType || this.inferMimeTypeFromFileName(media.fileName));
        if (!normalizedMime.startsWith("audio/") && !this.looksLikeAudioFileName(media.fileName)) {
          continue;
        }
        return {
          ...media,
          mimeType: normalizedMime || media.mimeType,
          source: media.source || candidate,
        };
      } catch {
        // Try next candidate.
      }
    }
    return undefined;
  }

  private resolveGatewaySessionKey(request: OpenClawBridgeRequest): string {
    const channel = (request.channel || "").trim().toLowerCase();
    const fallbackSession = (this.config.sessionKey || "").trim() || "main";
    if (channel !== "feishu") {
      return fallbackSession;
    }

    const agentId = this.resolveGatewayAgentId(fallbackSession);
    const chatType = this.normalizeInboundChatType(request.chatType);
    if (chatType === "group") {
      const groupId = this.sanitizeGatewaySessionPart(request.chatId, "group");
      return `agent:${agentId}:feishu:group:${groupId}`;
    }

    const dmPeer = this.sanitizeGatewaySessionPart(
      request.senderOpenId || request.senderUserId || request.senderId || request.chatId,
      "dm",
    );
    return `agent:${agentId}:feishu:dm:${dmPeer}`;
  }

  private resolveGatewayAgentId(fallbackSession: string): string {
    const normalized = fallbackSession.trim();
    const match = normalized.match(/^agent:([^:]+)(?::|$)/i);
    const candidate = (match?.[1] || normalized || "main").trim();
    return this.sanitizeGatewaySessionPart(candidate, "main");
  }

  private sanitizeGatewaySessionPart(value: string | undefined, fallback: string): string {
    const normalized = (value || "")
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!normalized) {
      return fallback;
    }
    return normalized.slice(0, 96);
  }

  private normalizeInboundChatType(chatType?: string): "group" | "direct" {
    const normalized = (chatType || "").trim().toLowerCase();
    if (normalized === "group" || normalized === "channel") {
      return "group";
    }
    if (
      normalized === "direct"
      || normalized === "dm"
      || normalized === "p2p"
      || normalized === "private"
    ) {
      return "direct";
    }
    return normalized.includes("group") ? "group" : "direct";
  }

  private buildFeishuInboundPayloadText(request: OpenClawBridgeRequest, text: string): string {
    const payloadText = text.trim();
    if (!payloadText) {
      return payloadText;
    }
    const channel = (request.channel || "").trim().toLowerCase();
    if (channel !== "feishu") {
      return payloadText;
    }
    if (payloadText.startsWith("/")) {
      return payloadText;
    }

    const messageId = (request.messageId || request.eventId || "unknown").trim() || "unknown";
    const senderId =
      (request.senderOpenId || request.senderUserId || request.senderId || "unknown").trim()
      || "unknown";
    const senderName = (request.senderName || "").trim() || senderId;
    const chatType = this.normalizeInboundChatType(request.chatType);
    const envelopeFrom = chatType === "group" ? `${request.chatId}:${senderId}` : senderId;
    const timestampMs =
      typeof request.timestamp === "number" && Number.isFinite(request.timestamp)
        ? request.timestamp
        : Date.now();
    const timestampLabel = this.formatFeishuEnvelopeTimestamp(timestampMs);
    let messageBody = `${senderName}: ${payloadText}`;
    const docToolHint = buildFeishuDocToolHint(payloadText);
    if (docToolHint) {
      messageBody += `\n\n${docToolHint}`;
    }
    if (request.hasAnyMention) {
      messageBody +=
        "\n\n[System: The content may include mention tags in the form <at user_id=\"...\">name</at>. Treat these as real mentions of Feishu entities (users or bots).]";
      const normalizedBotOpenId = toString(request.botOpenId).trim();
      if (normalizedBotOpenId) {
        messageBody += `\n[System: If user_id is "${normalizedBotOpenId}", that mention refers to you.]`;
      }
    }
    messageBody = `[message_id: ${messageId}]\n${messageBody}`;
    return `[Feishu ${envelopeFrom} ${timestampLabel}] ${messageBody}`;
  }

  private formatFeishuEnvelopeTimestamp(timestampMs: number): string {
    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) {
      return new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    }
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absOffset = Math.abs(offsetMinutes);
    const offsetHour = String(Math.floor(absOffset / 60)).padStart(2, "0");
    const offsetMinute = String(absOffset % 60).padStart(2, "0");
    return `${weekday} ${year}-${month}-${day} ${hour}:${minute}:${second} UTC${sign}${offsetHour}:${offsetMinute}`;
  }

  private composePrompt(
    text: string,
    historySeed?: HistorySeedEntry[],
    workspaceConstDeclaration?: string,
  ): string {
    const current = text.trim();
    const workdirPrefix = workspaceConstDeclaration
      ? [
          `您的工作目录是：${workspaceConstDeclaration}`,
          OPENCLAW_BRIDGE_WORKDIR_SEPARATOR,
          "如涉及文件或目录操作，请默认在该工作目录内执行，除非用户明确指定其他路径。",
        ]
      : [];
    const items = (historySeed ?? []).map((item) => item.content.trim()).filter(Boolean);
    if (items.length === 0) {
      return [...workdirPrefix, current].join("\n");
    }
    return [
      ...workdirPrefix,
      "以下是同一用户在本轮 @ 之前发送的上下文消息（按时间顺序）：",
      ...items.map((item, idx) => `${idx + 1}. ${item}`),
      "",
      "当前消息：",
      current,
    ].join("\n");
  }

  private injectAttachmentContextIntoText(
    text: string,
    context: { promptLines: string[] },
  ): string {
    const baseText = text.trim();
    if (context.promptLines.length === 0) {
      return baseText;
    }
    const sections: string[] = [];
    if (baseText) {
      sections.push(baseText);
    }
    sections.push(
      [
        "[系统提示] 已接收用户上传的附件（已保存到当前用户工作区，可直接读取）：",
        ...context.promptLines,
      ].join("\n"),
    );
    return sections.join("\n\n").trim();
  }

  private stageInboundAttachments(
    binding: OpenClawResolvedUserBinding,
    runtime: { workspaceDir: string },
    attachments: BridgeInboundAttachment[],
  ): {
    promptLines: string[];
    gatewayAttachments: Array<{ type: "image"; mimeType: string; fileName: string; content: string }>;
  } {
    if (attachments.length === 0) {
      return {
        promptLines: [],
        gatewayAttachments: [],
      };
    }

    const inboundRoot = path.join(runtime.workspaceDir, "inbound", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(inboundRoot, { recursive: true });
    this.ensurePathOwnerAndMode(inboundRoot, binding.account.uid, binding.account.gid, 0o700);

    const promptLines: string[] = [];
    const gatewayAttachments: Array<{ type: "image"; mimeType: string; fileName: string; content: string }> = [];

    for (const [index, item] of attachments.entries()) {
      const decoded = Buffer.from(item.contentBase64, "base64");
      if (decoded.byteLength === 0) {
        continue;
      }
      if (decoded.byteLength > OPENCLAW_BRIDGE_INBOUND_MAX_FILE_BYTES) {
        continue;
      }

      const safeName = this.sanitizeAttachmentFileName(
        item.fileName,
        `${item.messageType || "file"}-${index + 1}`,
      );
      const targetPath = path.join(inboundRoot, safeName);
      fs.writeFileSync(targetPath, decoded, { mode: 0o600 });
      this.ensurePathOwnerAndMode(targetPath, binding.account.uid, binding.account.gid, 0o600);

      const normalizedMimeType = this.normalizeMimeType(item.mimeType);
      const mimeType = normalizedMimeType === "application/octet-stream"
        ? this.inferMimeTypeFromFileName(safeName)
        : normalizedMimeType;
      promptLines.push(
        `${index + 1}. ${safeName} | type=${item.messageType || "file"} | mime=${mimeType} | path=${targetPath}`,
      );

      if (!this.isImageMimeType(mimeType) && item.messageType.trim().toLowerCase() !== "image") {
        continue;
      }
      gatewayAttachments.push({
        type: "image",
        mimeType: mimeType.startsWith("image/") ? mimeType : "image/png",
        fileName: safeName,
        content: item.contentBase64,
      });
    }

    return {
      promptLines,
      gatewayAttachments,
    };
  }

  private sanitizeAttachmentFileName(fileName: string, fallbackPrefix: string): string {
    const trimmed = fileName.trim();
    const base = path.basename(trimmed || `${fallbackPrefix}.bin`);
    const normalized = base
      .replace(/[\/\\]/g, "_")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    const fallback = `${fallbackPrefix}.bin`;
    return (normalized || fallback).slice(0, 120);
  }

  private normalizeMimeType(mime: string): string {
    const cleaned = mime.trim().split(";")[0]?.trim().toLowerCase() || "";
    return cleaned || "application/octet-stream";
  }

  private inferMimeTypeFromFileName(fileName: string): string {
    const ext = path.extname(fileName).trim().toLowerCase();
    switch (ext) {
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      case ".bmp":
        return "image/bmp";
      case ".svg":
        return "image/svg+xml";
      case ".pdf":
        return "application/pdf";
      case ".txt":
        return "text/plain";
      case ".json":
        return "application/json";
      case ".csv":
        return "text/csv";
      case ".md":
        return "text/markdown";
      case ".mp3":
        return "audio/mpeg";
      case ".wav":
        return "audio/wav";
      case ".ogg":
      case ".opus":
        return "audio/ogg";
      case ".m4a":
        return "audio/m4a";
      case ".aac":
        return "audio/aac";
      case ".flac":
        return "audio/flac";
      case ".amr":
        return "audio/amr";
      case ".mp4":
        return "video/mp4";
      default:
        return "application/octet-stream";
    }
  }

  private isImageMimeType(mimeType: string): boolean {
    return this.normalizeMimeType(mimeType).startsWith("image/");
  }

  private buildWorkspaceConstDeclaration(workspaceDir: string): string {
    return `const ${OPENCLAW_BRIDGE_WORKDIR_CONST_NAME} = ${JSON.stringify(workspaceDir)};`;
  }

  private resolveBuiltinSlashCommand(text: string): string | undefined {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/([a-zA-Z][\w-]*)\b/);
    if (!match) {
      return undefined;
    }
    const command = (match[1] ?? "").toLowerCase();
    if (!command || !OPENCLAW_BUILTIN_SLASH_COMMANDS.has(command)) {
      return undefined;
    }
    return command;
  }

  private resolveRequestUserKey(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): string {
    return resolveSenderUserKey(request);
  }

  resolveUserKeyFromRequest(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): string {
    return this.resolveRequestUserKey(request);
  }

  async resolveExecutionScope(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): Promise<OpenClawExecutionScope> {
    const binding = await this.ensureUserBinding(request);
    return {
      userKey: binding.userKey,
      linuxUser: binding.account.username,
      homeDir: binding.account.home,
    };
  }

  async listUserBindings(): Promise<Array<{
    userKey: string;
    linuxUser: string;
    gatewayPort: number;
    createdAt: string;
    updatedAt: string;
  }>> {
    const map = await this.loadUserMap();
    return Object.entries(map.users)
      .map(([userKey, binding]) => ({
        userKey,
        linuxUser: binding.linuxUser,
        gatewayPort: binding.gatewayPort,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      }))
      .sort((a, b) => a.userKey.localeCompare(b.userKey));
  }

  private deriveLinuxUser(userKey: string): string {
    const hash = createHash("sha1").update(userKey).digest("hex");
    const rawPrefix = this.config.userPrefix.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const safePrefix = rawPrefix && /^[a-z_]/.test(rawPrefix) ? rawPrefix : "tfoc_";
    const candidate = `${safePrefix}${hash.slice(0, 16)}`.replace(/[^a-z0-9_-]/g, "_");
    const limited = candidate.slice(0, 31);
    return /^[a-z_]/.test(limited) ? limited : `u${limited.slice(1)}`;
  }

  private resolveCanonicalUserKey(map: OpenClawUserMapFile, requestedUserKey: string): string {
    const normalized = requestedUserKey.trim();
    if (!normalized) {
      return normalized;
    }
    if (map.users[normalized]) {
      return normalized;
    }
    if (!/^tfoc_[a-f0-9]{16}$/i.test(normalized)) {
      return normalized;
    }
    const matched = Object.entries(map.users).find(([key, binding]) =>
      key !== normalized && binding.linuxUser.trim() === normalized);
    return matched?.[0] ?? normalized;
  }

  private buildRandomToken(): string {
    return randomBytes(24).toString("hex");
  }

  private async withMapLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mapLock;
    let release: (() => void) | undefined;
    this.mapLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  private async loadUserMap(): Promise<OpenClawUserMapFile> {
    if (!fs.existsSync(this.mapFilePath)) {
      return { version: 1, users: {} };
    }
    try {
      const rawText = fs.readFileSync(this.mapFilePath, "utf8");
      const parsed = toObject(JSON.parse(rawText));
      const rawUsers = toObject(parsed.users);
      const users: Record<string, OpenClawUserBinding> = {};
      for (const [key, value] of Object.entries(rawUsers)) {
        const item = toObject(value);
        const linuxUser = toString(item.linuxUser).trim();
        const gatewayPort = toNumber(item.gatewayPort, 0);
        const gatewayToken = toString(item.gatewayToken).trim();
        if (!linuxUser || gatewayPort <= 0) {
          continue;
        }
        users[key] = {
          linuxUser,
          gatewayPort,
          gatewayToken,
          createdAt: toString(item.createdAt, new Date().toISOString()),
          updatedAt: toString(item.updatedAt, new Date().toISOString()),
        };
      }
      return { version: 1, users };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse openclaw user map: ${msg}`);
    }
  }

  private async saveUserMap(map: OpenClawUserMapFile): Promise<void> {
    const dir = path.dirname(this.mapFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.mapFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(map, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.mapFilePath);
  }

  private async commandExists(command: string): Promise<boolean> {
    const probe = await this.runCommand("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      timeoutMs: 3000,
    });
    return probe.code === 0;
  }

  private async resolveRunAsMode(): Promise<"runuser" | "sudo" | "su"> {
    this.runAsModePromise ??= (async () => {
      if (await this.commandExists("runuser")) {
        return "runuser";
      }
      if (await this.commandExists("sudo")) {
        return "sudo";
      }
      if (await this.commandExists("su")) {
        return "su";
      }
      throw new Error("neither runuser/sudo/su is available on this host");
    })();
    return await this.runAsModePromise;
  }

  private async runAsUser(
    username: string,
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ): Promise<CommandRunResult> {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options?.env ?? {}),
    };
    delete mergedEnv.TMUX;
    delete mergedEnv.TMUX_PANE;

    const runOptions = {
      cwd: options?.cwd,
      env: mergedEnv,
      timeoutMs: options?.timeoutMs,
    };

    const mode = await this.resolveRunAsMode();
    if (mode === "runuser") {
      return await this.runCommand("runuser", ["-u", username, "--", command, ...args], runOptions);
    }
    if (mode === "sudo") {
      return await this.runCommand("sudo", ["-u", username, "--", command, ...args], runOptions);
    }
    const cmdline = [command, ...args].map(shellQuote).join(" ");
    return await this.runCommand("su", ["-s", "/bin/bash", "-", username, "-c", cmdline], runOptions);
  }

  private parsePasswdLine(line: string): LinuxUserAccount | undefined {
    const parts = line.split(":");
    if (parts.length < 7) {
      return undefined;
    }
    const username = (parts[0] ?? "").trim();
    const uid = Number.parseInt(parts[2] ?? "", 10);
    const gid = Number.parseInt(parts[3] ?? "", 10);
    const home = (parts[5] ?? "").trim();
    const shell = (parts[6] ?? "").trim();
    if (!username || !Number.isFinite(uid) || !Number.isFinite(gid)) {
      return undefined;
    }
    return {
      username,
      uid,
      gid,
      home: home || this.expectedLinuxHomeDir(username),
      shell: shell || "/bin/bash",
    };
  }

  private expectedLinuxHomeDir(username: string): string {
    return path.join(path.resolve(this.config.userHomeRoot), username);
  }

  private ensureLinuxHomePermissions(account: LinuxUserAccount): void {
    const homeRoot = path.resolve(this.config.userHomeRoot);
    fs.mkdirSync(homeRoot, { recursive: true });
    try {
      fs.chmodSync(homeRoot, 0o711);
    } catch {
      // Ignore mode errors and continue.
    }
    fs.mkdirSync(account.home, { recursive: true });
    this.ensurePathOwnerAndMode(account.home, account.uid, account.gid, 0o700);
  }

  private async ensureLinuxUserHomeRoot(account: LinuxUserAccount): Promise<LinuxUserAccount> {
    const expectedHome = this.expectedLinuxHomeDir(account.username);
    const currentHome = path.resolve(account.home);
    if (currentHome === expectedHome) {
      return account;
    }
    const uid = process.getuid?.();
    if (uid !== 0) {
      throw new Error(
        `linux user ${account.username} home mismatch (${currentHome} != ${expectedHome}). run gateway as root once to migrate home.`,
      );
    }

    fs.mkdirSync(path.dirname(expectedHome), { recursive: true });
    const migrated = await this.runCommand("usermod", ["-d", expectedHome, "-m", account.username], {
      timeoutMs: 60_000,
    });
    if (migrated.code !== 0) {
      const refreshedAfterFailure = await this.queryLinuxUser(account.username);
      if (refreshedAfterFailure && path.resolve(refreshedAfterFailure.home) === expectedHome) {
        return refreshedAfterFailure;
      }
      const details = migrated.stderr.trim() || migrated.stdout.trim() || "unknown error";
      throw new Error(
        `failed to migrate linux user ${account.username} home (${currentHome} -> ${expectedHome}): ${details}`,
      );
    }
    const refreshed = await this.queryLinuxUser(account.username);
    if (!refreshed) {
      throw new Error(`linux user ${account.username} home migrated but account lookup failed`);
    }
    return refreshed;
  }

  private async queryLinuxUser(username: string): Promise<LinuxUserAccount | undefined> {
    const result = await this.runCommand("getent", ["passwd", username], { timeoutMs: 5000 });
    if (result.code !== 0) {
      return undefined;
    }
    const line = result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${username}:`));
    if (!line) {
      return undefined;
    }
    return this.parsePasswdLine(line);
  }

  private async ensureLinuxUser(username: string): Promise<LinuxUserAccount> {
    const existing = await this.queryLinuxUser(username);
    if (existing) {
      const normalized = await this.ensureLinuxUserHomeRoot(existing);
      this.ensureLinuxHomePermissions(normalized);
      return normalized;
    }
    if (!this.config.allowAutoCreateUser) {
      throw new Error(`linux user ${username} does not exist and auto-create is disabled`);
    }
    const uid = process.getuid?.();
    if (uid !== 0) {
      throw new Error(`linux user ${username} does not exist. run gateway as root to auto-create users`);
    }
    const homeDir = this.expectedLinuxHomeDir(username);
    fs.mkdirSync(path.dirname(homeDir), { recursive: true });
    const created = await this.runCommand("useradd", ["-m", "-d", homeDir, "-s", "/bin/bash", username], {
      timeoutMs: 10_000,
    });
    if (created.code !== 0) {
      const retried = await this.queryLinuxUser(username);
      if (retried) {
        return retried;
      }
      throw new Error(`failed to create linux user ${username}: ${created.stderr.trim() || "unknown error"}`);
    }
    const account = await this.queryLinuxUser(username);
    if (!account) {
      throw new Error(`linux user ${username} created but account lookup failed`);
    }
    this.ensureLinuxHomePermissions(account);
    return account;
  }

  private async isPortAvailable(host: string, port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => {
        resolve(false);
      });
      server.listen(port, host, () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private async waitForPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
      if (await this.isPortOpen(host, port)) {
        return true;
      }
      await delay(300);
    }
    return false;
  }

  private async waitForPortClosed(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
      if (!(await this.isPortOpen(host, port))) {
        return true;
      }
      await delay(300);
    }
    return !(await this.isPortOpen(host, port));
  }

  private async killOpenClawGatewayProcessesForUser(username: string): Promise<void> {
    await this.runCommand("pkill", ["-u", username, "-f", "openclaw.mjs gateway"], {
      timeoutMs: 5000,
    });
    await this.runCommand("pkill", ["-u", username, "-f", "^openclaw-gateway( |$)"], {
      timeoutMs: 5000,
    });
    await this.runCommand("pkill", ["-u", username, "-x", "openclaw-gatewa"], {
      timeoutMs: 5000,
    });
  }

  private async allocateGatewayPort(map: OpenClawUserMapFile, seed: string): Promise<number> {
    const minPort = Math.max(1, this.config.gatewayPortBase);
    const maxPort = Math.max(minPort, this.config.gatewayPortMax);
    const span = maxPort - minPort + 1;
    const used = new Set<number>();
    for (const item of Object.values(map.users)) {
      if (Number.isFinite(item.gatewayPort) && item.gatewayPort >= minPort && item.gatewayPort <= maxPort) {
        used.add(item.gatewayPort);
      }
    }
    const hashSeed = Number.parseInt(seed.slice(0, 8), 16);
    for (let i = 0; i < span; i += 1) {
      const candidate = minPort + ((hashSeed + i) % span);
      if (used.has(candidate)) {
        continue;
      }
      if (await this.isPortAvailable(this.config.gatewayHost, candidate)) {
        return candidate;
      }
    }
    throw new Error(`no available openclaw gateway port in ${minPort}-${maxPort}`);
  }

  private async ensureUserBinding(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): Promise<OpenClawResolvedUserBinding> {
    const requestedUserKey = this.resolveRequestUserKey(request);
    if (!requestedUserKey) {
      throw new Error("missing feishu sender identity (open_id/user_id/sender_id)");
    }

    return await this.withMapLock(async () => {
      const nowIso = new Date().toISOString();
      const map = await this.loadUserMap();
      const userKey = this.resolveCanonicalUserKey(map, requestedUserKey);
      const seedHash = createHash("sha1").update(userKey).digest("hex");
      const existing = map.users[userKey];
      let entry: OpenClawUserBinding = existing
        ? { ...existing }
        : {
            linuxUser: this.deriveLinuxUser(userKey),
            gatewayPort: 0,
            gatewayToken: "",
            createdAt: nowIso,
            updatedAt: nowIso,
          };

      let changed = !existing;
      if (!entry.gatewayToken.trim()) {
        entry.gatewayToken = this.buildRandomToken();
        changed = true;
      }
      if (!Number.isFinite(entry.gatewayPort) || entry.gatewayPort <= 0) {
        entry.gatewayPort = await this.allocateGatewayPort(map, seedHash);
        changed = true;
      }

      const account = await this.ensureLinuxUser(entry.linuxUser);

      if (changed) {
        entry.updatedAt = nowIso;
      }
      map.users[userKey] = entry;
      if (changed || !existing) {
        await this.saveUserMap(map);
      }

      return {
        userKey,
        linuxUser: entry.linuxUser,
        gatewayPort: entry.gatewayPort,
        gatewayToken: entry.gatewayToken,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        account,
      };
    });
  }

  private userRuntimeDir(binding: OpenClawResolvedUserBinding): string {
    return path.join(binding.account.home, ".tfclaw-openclaw");
  }

  private userDefaultWorkspaceDir(binding: OpenClawResolvedUserBinding): string {
    return path.join(this.userRuntimeDir(binding), "workspace");
  }

  private resolveCommonWorkspaceDir(): string {
    const overrideDir = toString(process.env.TFCLAW_COMMON_WORKSPACE_DIR).trim();
    if (overrideDir) {
      return path.resolve(overrideDir);
    }
    return path.resolve(path.dirname(this.config.openclawRoot), OPENCLAW_BRIDGE_COMMON_WORKSPACE_DIR_NAME);
  }

  private shouldSeedPrivateWorkspace(privateWorkspaceDir: string): boolean {
    if (!fs.existsSync(privateWorkspaceDir)) {
      return true;
    }
    const markerPath = path.join(privateWorkspaceDir, OPENCLAW_BRIDGE_WORKSPACE_SEED_MARKER_NAME);
    if (fs.existsSync(markerPath)) {
      return false;
    }
    const stat = fs.statSync(privateWorkspaceDir);
    if (!stat.isDirectory()) {
      return false;
    }
    const entries = fs.readdirSync(privateWorkspaceDir, { withFileTypes: true });
    if (entries.length === 0) {
      return true;
    }
    return entries.every((entry) => OPENCLAW_BRIDGE_WORKSPACE_SEED_ALLOWED_EXISTING_ENTRIES.has(entry.name));
  }

  private stripWorkspaceTemplateFrontMatter(content: string): string {
    if (!content.startsWith("---")) {
      return content;
    }
    const endIndex = content.indexOf("\n---", 3);
    if (endIndex < 0) {
      return content;
    }
    return content.slice(endIndex + "\n---".length).replace(/^\s+/, "");
  }

  private copyDirectoryChildrenWithoutSkills(sourceDir: string, targetDir: string): void {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "skills") {
        continue;
      }
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (fs.existsSync(targetPath)) {
        continue;
      }
      fs.cpSync(sourcePath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: false,
        dereference: false,
      });
    }
  }

  private seedWorkspaceFromOpenClawTemplates(targetDir: string): string {
    const templateDir = path.join(this.config.openclawRoot, "docs", "reference", "templates");
    let seededCount = 0;
    for (const templateName of OPENCLAW_BRIDGE_WORKSPACE_TEMPLATE_FILENAMES) {
      const sourcePath = path.join(templateDir, templateName);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      const targetPath = path.join(targetDir, templateName);
      if (fs.existsSync(targetPath)) {
        continue;
      }
      const raw = fs.readFileSync(sourcePath, "utf8");
      const content = this.stripWorkspaceTemplateFrontMatter(raw);
      fs.writeFileSync(targetPath, content.endsWith("\n") ? content : `${content}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      seededCount += 1;
    }
    if (seededCount === 0) {
      throw new Error(`workspace template files not found under ${templateDir}`);
    }
    return templateDir;
  }

  private writeWorkspaceSeedMarker(targetDir: string, source: string): void {
    const markerPath = path.join(targetDir, OPENCLAW_BRIDGE_WORKSPACE_SEED_MARKER_NAME);
    const payload = {
      version: 1,
      seededAt: new Date().toISOString(),
      source,
    };
    fs.writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private ensureTreeOwnerAndMode(targetPath: string, uid: number, gid: number): void {
    if (!fs.existsSync(targetPath)) {
      return;
    }
    const queue: string[] = [targetPath];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        this.ensurePathOwnerAndMode(current, uid, gid, 0o700);
        let children: string[] = [];
        try {
          children = fs.readdirSync(current);
        } catch {
          continue;
        }
        for (const child of children) {
          queue.push(path.join(current, child));
        }
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          fs.lchownSync(current, uid, gid);
        } catch {
          // Ignore ownership errors and continue.
        }
        continue;
      }
      const executable = (stat.mode & 0o111) !== 0;
      this.ensurePathOwnerAndMode(current, uid, gid, executable ? 0o700 : 0o600);
    }
  }

  private initializePrivateWorkspace(binding: OpenClawResolvedUserBinding, privateWorkspaceDir: string): void {
    const commonWorkspaceDir = this.resolveCommonWorkspaceDir();
    let sourceLabel = "";
    if (fs.existsSync(commonWorkspaceDir) && fs.statSync(commonWorkspaceDir).isDirectory()) {
      this.copyDirectoryChildrenWithoutSkills(commonWorkspaceDir, privateWorkspaceDir);
      sourceLabel = commonWorkspaceDir;
    } else {
      sourceLabel = this.seedWorkspaceFromOpenClawTemplates(privateWorkspaceDir);
    }
    this.writeWorkspaceSeedMarker(privateWorkspaceDir, sourceLabel);
    this.ensureTreeOwnerAndMode(privateWorkspaceDir, binding.account.uid, binding.account.gid);
    console.log(
      `[gateway] openclaw workspace initialized for ${binding.account.username}: ${sourceLabel}`,
    );
  }

  private workspaceEnvFilePath(binding: OpenClawResolvedUserBinding): string {
    return path.join(this.userDefaultWorkspaceDir(binding), OPENCLAW_BRIDGE_WORKSPACE_ENV_FILE_NAME);
  }

  private legacyUserEnvFilePath(binding: OpenClawResolvedUserBinding): string {
    return path.join(this.userRuntimeDir(binding), OPENCLAW_BRIDGE_LEGACY_USER_ENV_FILE_NAME);
  }

  private normalizeEnvVarKey(rawKey: string): string {
    const key = rawKey.trim();
    if (!key || !OPENCLAW_BRIDGE_ENV_VAR_PATTERN.test(key)) {
      throw new Error(`invalid env key: ${rawKey}`);
    }
    return key;
  }

  private normalizeUserEnvVars(input: Record<string, unknown>): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(input)) {
      const key = rawKey.trim();
      if (!key || !OPENCLAW_BRIDGE_ENV_VAR_PATTERN.test(key)) {
        continue;
      }
      if (typeof rawValue !== "string") {
        continue;
      }
      const value = rawValue;
      if (!value || value.length > OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH) {
        continue;
      }
      vars[key] = value;
    }
    return vars;
  }

  private isSensitiveEnvVarKey(rawKey: string): boolean {
    const key = rawKey.trim().toLowerCase();
    return /(api[_-]?key|access[_-]?key|secret|token|password|passwd)/.test(key);
  }

  private isPlaceholderSecretValue(rawValue: string): boolean {
    const value = rawValue.trim().toLowerCase();
    if (!value) {
      return false;
    }
    if (
      value === "your_moss_api_key"
      || value === "your_api_key"
      || value === "api_key_here"
      || value === "token_here"
      || value === "secret_here"
      || value === "changeme"
      || value === "replace_me"
      || value === "replace-with-real-value"
      || value === "placeholder"
      || value === "none"
      || value === "null"
      || value === "undefined"
      || value === "xxx"
    ) {
      return true;
    }
    return (
      value.startsWith("your_")
      || value.startsWith("your-")
      || value.startsWith("<")
      || value.startsWith("${")
      || value.startsWith("sk-your")
      || value.includes("your_moss_api_key")
      || value.includes("your_api_key")
      || value.includes("api_key_here")
      || value.includes("token_here")
      || value.includes("secret_here")
      || value.includes("replace_me")
      || value.includes("changeme")
    );
  }

  private sanitizePrivateEnvOverrides(vars: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(vars)) {
      if (this.isSensitiveEnvVarKey(key) && this.isPlaceholderSecretValue(value)) {
        continue;
      }
      sanitized[key] = value;
    }
    return sanitized;
  }

  private parseDotenvFileVars(envFilePath: string): Record<string, string> {
    if (!envFilePath.trim()) {
      return {};
    }
    if (!fs.existsSync(envFilePath)) {
      return {};
    }
    let text = "";
    try {
      text = fs.readFileSync(envFilePath, "utf8");
    } catch {
      return {};
    }
    const vars: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("export ")) {
        line = line.slice("export ".length).trim();
      }
      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      const key = line.slice(0, separatorIndex).trim();
      if (!OPENCLAW_BRIDGE_ENV_VAR_PATTERN.test(key)) {
        continue;
      }
      let value = line.slice(separatorIndex + 1).trim();
      if (!value || value.length > OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH) {
        continue;
      }
      if (
        value.length >= 2
        && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (!value || value.length > OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH) {
        continue;
      }
      vars[key] = value;
    }
    return vars;
  }

  private loadRuntimeEnvVars(
    _binding: OpenClawResolvedUserBinding,
    workspaceRoot: string,
    userEnvVars: Record<string, string>,
  ): Record<string, string> {
    const merged: Record<string, string> = {
      ...userEnvVars,
    };
    const resolvedMoss = (merged.MOSS_API_KEY || merged.moss_api_key || "").trim();
    if (resolvedMoss) {
      merged.MOSS_API_KEY = resolvedMoss;
      merged.moss_api_key = resolvedMoss;
    }
    merged.CLAWHUB_WORKDIR = path.resolve(workspaceRoot);
    return merged;
  }

  private loadLegacyUserPrivateEnvVars(binding: OpenClawResolvedUserBinding): Record<string, string> {
    const legacyEnvFilePath = this.legacyUserEnvFilePath(binding);
    if (!fs.existsSync(legacyEnvFilePath)) {
      return {};
    }
    try {
      const parsed = toObject(JSON.parse(fs.readFileSync(legacyEnvFilePath, "utf8")));
      const rawVars = Object.prototype.hasOwnProperty.call(parsed, "vars")
        ? toObject(parsed.vars)
        : parsed;
      return this.sanitizePrivateEnvOverrides(this.normalizeUserEnvVars(rawVars));
    } catch {
      return {};
    }
  }

  private formatDotenvValue(value: string): string {
    if (/^[A-Za-z0-9_./:@+,-]+$/.test(value)) {
      return value;
    }
    return JSON.stringify(value);
  }

  private writeUserPrivateEnvFile(
    binding: OpenClawResolvedUserBinding,
    envFilePath: string,
    vars: Record<string, string>,
  ): void {
    const workspaceDir = path.dirname(envFilePath);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const lines = Object.entries(vars)
      .filter(([key, value]) => {
        if (!OPENCLAW_BRIDGE_ENV_VAR_PATTERN.test(key)) {
          return false;
        }
        if (typeof value !== "string" || !value || value.length > OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH) {
          return false;
        }
        return true;
      })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${this.formatDotenvValue(value)}`);
    fs.writeFileSync(envFilePath, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.ensurePathOwnerAndMode(workspaceDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(envFilePath, binding.account.uid, binding.account.gid, 0o600);
  }

  private loadUserPrivateEnvVars(binding: OpenClawResolvedUserBinding): {
    envFilePath: string;
    vars: Record<string, string>;
  } {
    const envFilePath = this.workspaceEnvFilePath(binding);
    const legacyEnvFilePath = this.legacyUserEnvFilePath(binding);
    const sharedEnvVars = this.parseDotenvFileVars(path.resolve(this.config.sharedEnvPath));
    const workspaceEnvVars = this.sanitizePrivateEnvOverrides(this.parseDotenvFileVars(envFilePath));
    const legacyEnvVars = this.loadLegacyUserPrivateEnvVars(binding);
    const mergedPrivateVars = {
      ...legacyEnvVars,
      ...workspaceEnvVars,
    };
    let vars: Record<string, string> = {
      ...sharedEnvVars,
      ...mergedPrivateVars,
    };

    const sharedMoss = (sharedEnvVars.MOSS_API_KEY || sharedEnvVars.moss_api_key || "").trim();
    if (sharedMoss) {
      vars.MOSS_API_KEY = sharedMoss;
      vars.moss_api_key = sharedMoss;
    } else {
      const resolvedMoss = (vars.MOSS_API_KEY || vars.moss_api_key || "").trim();
      if (resolvedMoss) {
        vars.MOSS_API_KEY = resolvedMoss;
        vars.moss_api_key = resolvedMoss;
      }
    }

    this.writeUserPrivateEnvFile(binding, envFilePath, vars);
    if (fs.existsSync(legacyEnvFilePath)) {
      try {
        fs.rmSync(legacyEnvFilePath, { force: true });
      } catch {
        // Ignore cleanup failures; runtime already switched to workspace/.env.
      }
    }
    return { envFilePath, vars };
  }

  async listUserPrivateEnvVars(userKey: string): Promise<{
    envFilePath: string;
    vars: Record<string, string>;
  }> {
    if (!this.enabled) {
      throw new Error("openclaw bridge is disabled");
    }
    const binding = await this.ensureUserBinding({ routingUserKey: userKey });
    return this.loadUserPrivateEnvVars(binding);
  }

  async setUserPrivateEnvVar(userKey: string, rawKey: string, rawValue: string): Promise<{
    key: string;
    envFilePath: string;
  }> {
    if (!this.enabled) {
      throw new Error("openclaw bridge is disabled");
    }
    const key = this.normalizeEnvVarKey(rawKey);
    const value = rawValue.trim();
    if (!value) {
      throw new Error("env value cannot be empty");
    }
    if (value.length > OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH) {
      throw new Error(`env value too long (max ${OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH} chars)`);
    }

    const binding = await this.ensureUserBinding({ routingUserKey: userKey });
    const envState = this.loadUserPrivateEnvVars(binding);
    envState.vars[key] = value;
    this.writeUserPrivateEnvFile(binding, envState.envFilePath, envState.vars);

    const runtime = this.prepareUserRuntime(binding);
    await this.ensureTmuxOpenClawProcess(binding, runtime, { forceRestart: true });
    return { key, envFilePath: envState.envFilePath };
  }

  async unsetUserPrivateEnvVar(userKey: string, rawKey: string): Promise<{
    key: string;
    removed: boolean;
    envFilePath: string;
  }> {
    if (!this.enabled) {
      throw new Error("openclaw bridge is disabled");
    }
    const key = this.normalizeEnvVarKey(rawKey);
    if (key === "CLAWHUB_WORKDIR") {
      throw new Error("CLAWHUB_WORKDIR is managed by tfclaw and cannot be removed");
    }

    const binding = await this.ensureUserBinding({ routingUserKey: userKey });
    const envState = this.loadUserPrivateEnvVars(binding);
    const removed = Object.prototype.hasOwnProperty.call(envState.vars, key);
    if (removed) {
      delete envState.vars[key];
      this.writeUserPrivateEnvFile(binding, envState.envFilePath, envState.vars);
      const runtime = this.prepareUserRuntime(binding);
      await this.ensureTmuxOpenClawProcess(binding, runtime, { forceRestart: true });
    }
    return { key, removed, envFilePath: envState.envFilePath };
  }

  private buildOpenClawConfig(
    baseConfig: Record<string, unknown>,
    binding: OpenClawResolvedUserBinding,
    workspaceRoot: string,
    runtimeEnvVars: Record<string, string>,
  ): Record<string, unknown> {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = toObject(JSON.parse(JSON.stringify(baseConfig)));
    } catch {
      cfg = {};
    }

    const userSkillsDir = path.join(binding.account.home, "skills");
    const workspaceSkillsDir = path.join(workspaceRoot, "skills");
    const sharedSkillsDir = path.resolve(this.config.sharedSkillsDir);
    const openclawExtensionsDir = path.resolve(this.config.openclawRoot, "extensions");
    const feishuExtensionSkillsDir = path.resolve(
      this.config.openclawRoot,
      "extensions",
      "feishu",
      "skills",
    );

    const gateway = toObject(cfg.gateway);
    gateway.mode = "local";
    gateway.bind = "loopback";
    gateway.port = binding.gatewayPort;
    gateway.auth = {
      mode: "token",
      token: binding.gatewayToken,
    };
    cfg.gateway = gateway;

    const channels = toObject(cfg.channels);
    const feishu = toObject(channels.feishu);
    // Enable per-user Feishu channel so feishu_* tools are fully available.
    // Outbound conversational replies still flow through TFClaw bridge because
    // per-user sessions are served by TFClaw gateway websocket calls.
    feishu.enabled = true;
    const toolAppId = this.config.feishuAppId.trim();
    const toolAppSecret = this.config.feishuAppSecret.trim();
    const verificationToken = this.config.feishuVerificationToken.trim() || `tfclaw-${binding.account.username}`;
    const toolEncryptKey = this.config.feishuEncryptKey.trim();
    const webhookPort = Math.max(
      1024,
      Math.min(65535, binding.gatewayPort + this.config.feishuWebhookPortOffset),
    );
    if (toolAppId) {
      feishu.appId = toolAppId;
    }
    if (toolAppSecret) {
      feishu.appSecret = toolAppSecret;
    }
    feishu.connectionMode = "webhook";
    feishu.webhookHost = "127.0.0.1";
    feishu.webhookPort = webhookPort;
    feishu.webhookPath = "/feishu/events";
    feishu.verificationToken = verificationToken;
    if (toolEncryptKey) {
      feishu.encryptKey = toolEncryptKey;
    }
    const feishuTools = toObject(feishu.tools);
    feishuTools.doc = true;
    feishuTools.wiki = true;
    feishuTools.drive = true;
    feishuTools.scopes = true;
    feishuTools.perm = true;
    feishuTools.chat = true;
    feishu.tools = feishuTools;
    delete feishu.accounts;
    delete feishu.defaultAccount;
    channels.feishu = feishu;
    cfg.channels = channels;

    const plugins = toObject(cfg.plugins);
    const pluginEntries = toObject(plugins.entries);
    const feishuPlugin = toObject(pluginEntries.feishu);
    feishuPlugin.enabled = true;
    pluginEntries.feishu = feishuPlugin;
    plugins.entries = pluginEntries;
    cfg.plugins = plugins;

    const agents = toObject(cfg.agents);
    const defaults = toObject(agents.defaults);
    defaults.workspace = workspaceRoot;
    const compaction = toObject(defaults.compaction);
    if (!toString(compaction.mode).trim()) {
      compaction.mode = "safeguard";
    }
    if (!Object.prototype.hasOwnProperty.call(compaction, "reserveTokensFloor")) {
      compaction.reserveTokensFloor = OPENCLAW_BRIDGE_COMPACTION_RESERVE_TOKENS_FLOOR;
    }
    defaults.compaction = compaction;
    agents.defaults = defaults;

    const configuredAgents = Array.isArray(agents.list) ? agents.list : [];
    agents.list = configuredAgents.map((entry) => {
      const nextAgent = toObject(entry);
      const subagents = toObject(nextAgent.subagents);
      const allowAgents = Array.isArray(subagents.allowAgents)
        ? subagents.allowAgents
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
      if (!allowAgents.includes("*")) {
        return nextAgent;
      }

      const sanitizedAllowAgents = Array.from(new Set(allowAgents.filter((item) => item !== "*")));
      if (sanitizedAllowAgents.length === 0) {
        sanitizedAllowAgents.push("main");
      }
      subagents.allowAgents = sanitizedAllowAgents;
      nextAgent.subagents = subagents;
      return nextAgent;
    });
    cfg.agents = agents;

    // Load user-personalized skills from <user-home>/skills.
    const skills = toObject(cfg.skills);
    const load = toObject(skills.load);
    const normalizedUserSkillsDir = path.resolve(userSkillsDir);
    const normalizedWorkspaceSkillsDir = path.resolve(workspaceSkillsDir);
    const normalizedSharedSkillsDir = path.resolve(sharedSkillsDir);
    const normalizedOpenClawExtensionsDir = path.resolve(openclawExtensionsDir);
    const normalizedFeishuExtensionSkillsDir = path.resolve(feishuExtensionSkillsDir);
    // Keep skills sources deterministic: shared + per-user private (+ per-user workspace skills).
    load.extraDirs = [normalizedSharedSkillsDir, normalizedUserSkillsDir, normalizedWorkspaceSkillsDir];
    skills.load = load;
    cfg.skills = skills;

    const env = toObject(cfg.env);
    const envVars = toObject(env.vars);
    for (const [key, value] of Object.entries(runtimeEnvVars)) {
      if (!OPENCLAW_BRIDGE_ENV_VAR_PATTERN.test(key)) {
        continue;
      }
      if (typeof value !== "string" || !value || value.length > OPENCLAW_BRIDGE_ENV_VALUE_MAX_LENGTH) {
        continue;
      }
      envVars[key] = value;
    }
    env.vars = envVars;
    cfg.env = env;

    // Per-user bridge is the only ingress/egress; disable template bindings to avoid cross-user drift.
    cfg.bindings = [];

    const commands = toObject(cfg.commands);
    if (!("native" in commands)) {
      commands.native = "auto";
    }
    if (!("nativeSkills" in commands)) {
      commands.nativeSkills = "auto";
    }
    if (!("restart" in commands)) {
      commands.restart = true;
    }
    if (!("ownerDisplay" in commands)) {
      commands.ownerDisplay = "raw";
    }
    cfg.commands = commands;

    // Enforce per-user filesystem boundary while allowing command execution as the mapped linux user.
    const tools = toObject(cfg.tools);
    const exec = toObject(tools.exec);
    // Force host exec policy evaluation path and disable interactive approvals.
    exec.host = "gateway";
    exec.security = "full";
    exec.ask = "off";
    const applyPatch = toObject(exec.applyPatch);
    applyPatch.workspaceOnly = true;
    exec.applyPatch = applyPatch;
    tools.exec = exec;

    const fsTools = toObject(tools.fs);
    fsTools.workspaceOnly = true;
    const configuredReadOnlyRoots = Array.isArray(fsTools.readOnlyRoots)
      ? fsTools.readOnlyRoots.filter((entry): entry is string => typeof entry === "string")
      : [];
    fsTools.readOnlyRoots = Array.from(
      new Set([
        ...configuredReadOnlyRoots.map((entry) => path.resolve(entry)),
        normalizedSharedSkillsDir,
        normalizedFeishuExtensionSkillsDir,
        normalizedOpenClawExtensionsDir,
      ]),
    );
    tools.fs = fsTools;
    const denyList = Array.isArray(tools.deny)
      ? tools.deny
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && item.toLowerCase() !== "message")
      : [];
    tools.deny = denyList;
    cfg.tools = tools;

    return cfg;
  }

  private readJsonObjectFile(filePath: string): Record<string, unknown> {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      return toObject(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch {
      return {};
    }
  }

  private preserveOpenClawManagedConfigFields(
    nextConfig: Record<string, unknown>,
    existingConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = toObject(JSON.parse(JSON.stringify(nextConfig)));
    const existing = toObject(existingConfig);

    if (Object.prototype.hasOwnProperty.call(existing, "plugins")) {
      const mergedPlugins = toObject(merged.plugins);
      const existingPlugins = toObject(existing.plugins);

      const mergedEntries = toObject(mergedPlugins.entries);
      const existingEntries = toObject(existingPlugins.entries);
      mergedPlugins.entries = {
        ...existingEntries,
        ...mergedEntries,
      };

      const mergedInstalls = toObject(mergedPlugins.installs);
      const existingInstalls = toObject(existingPlugins.installs);
      mergedPlugins.installs = {
        ...existingInstalls,
        ...mergedInstalls,
      };

      merged.plugins = mergedPlugins;
    }
    if (Object.prototype.hasOwnProperty.call(existing, "commands")) {
      merged.commands = {
        ...toObject(existing.commands),
        ...toObject(merged.commands),
      };
    }
    if (Object.prototype.hasOwnProperty.call(existing, "meta")) {
      merged.meta = existing.meta;
    }

    return merged;
  }

  private buildComparableOpenClawConfigSnapshot(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map((item) => this.buildComparableOpenClawConfigSnapshot(item));
    }
    if (!input || typeof input !== "object") {
      return input;
    }

    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (key === "meta") {
        const meta = toObject(obj.meta);
        const comparableMeta: Record<string, unknown> = {};
        for (const metaKey of Object.keys(meta).sort()) {
          if (metaKey === "lastTouchedAt") {
            continue;
          }
          comparableMeta[metaKey] = this.buildComparableOpenClawConfigSnapshot(meta[metaKey]);
        }
        if (Object.keys(comparableMeta).length > 0) {
          out.meta = comparableMeta;
        }
        continue;
      }
      out[key] = this.buildComparableOpenClawConfigSnapshot(obj[key]);
    }
    return out;
  }

  private shouldRewriteOpenClawConfig(
    configPath: string,
    nextConfig: Record<string, unknown>,
  ): boolean {
    if (!fs.existsSync(configPath)) {
      return true;
    }
    const existingConfig = this.readJsonObjectFile(configPath);
    const currentComparable = this.buildComparableOpenClawConfigSnapshot(existingConfig);
    const nextComparable = this.buildComparableOpenClawConfigSnapshot(nextConfig);
    return JSON.stringify(currentComparable) !== JSON.stringify(nextComparable);
  }

  private ensurePathOwnerAndMode(targetPath: string, uid: number, gid: number, mode: number): void {
    try {
      fs.chownSync(targetPath, uid, gid);
    } catch {
      // Ignore ownership errors and continue.
    }
    try {
      fs.chmodSync(targetPath, mode);
    } catch {
      // Ignore mode errors and continue.
    }
  }

  private writeExecApprovalsForUser(binding: OpenClawResolvedUserBinding): string {
    const stateDir = path.join(binding.account.home, ".openclaw");
    const approvalsPath = path.join(stateDir, "exec-approvals.json");
    fs.mkdirSync(stateDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(approvalsPath)) {
      try {
        existing = toObject(JSON.parse(fs.readFileSync(approvalsPath, "utf8")));
      } catch {
        existing = {};
      }
    }

    const socket = toObject(existing.socket);
    const token = toString(socket.token).trim() || this.buildRandomToken();
    const socketPath = toString(socket.path).trim() || path.join(stateDir, "exec-approvals.sock");

    const defaults = toObject(existing.defaults);
    defaults.security = "full";
    defaults.ask = "off";
    defaults.askFallback = "full";

    const agents = toObject(existing.agents);
    const mainAgent = toObject(agents.main);
    mainAgent.security = "full";
    mainAgent.ask = "off";
    mainAgent.askFallback = "full";
    agents.main = mainAgent;

    const normalized = {
      version: 1,
      socket: {
        path: socketPath,
        token,
      },
      defaults,
      agents,
    };

    fs.writeFileSync(approvalsPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.ensurePathOwnerAndMode(stateDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(approvalsPath, binding.account.uid, binding.account.gid, 0o600);
    return approvalsPath;
  }

  private buildExecJailShellScript(): string {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      'REAL_SHELL="${TFCLAW_EXEC_REAL_SHELL:-/bin/bash}"',
      'WORKSPACE="${TFCLAW_EXEC_WORKSPACE:-${PWD}}"',
      'USER_HOME="${TFCLAW_EXEC_HOME:-${HOME:-$WORKSPACE}}"',
      'USER_NAME="${USER:-$(id -un 2>/dev/null || echo user)}"',
      'NODE_BIN_DIR="${TFCLAW_EXEC_NODE_BIN_DIR:-}"',
      'NODE_BIN=""',
      'PATH_DEFAULT="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"',
      'if [[ -n "$NODE_BIN_DIR" && -d "$NODE_BIN_DIR" ]]; then',
      '  PATH_DEFAULT="$NODE_BIN_DIR:$PATH_DEFAULT"',
      '  if [[ -x "$NODE_BIN_DIR/node" ]]; then',
      '    NODE_BIN="$NODE_BIN_DIR/node"',
      "  fi",
      "fi",
      "",
      'if [[ "${1:-}" != "-c" || $# -lt 2 ]]; then',
      '  exec "$REAL_SHELL" "$@"',
      "fi",
      "",
      'CMD="$2"',
      'WORKSPACE="$(readlink -f "$WORKSPACE" 2>/dev/null || realpath "$WORKSPACE" 2>/dev/null || echo "$WORKSPACE")"',
      'USER_HOME="$(readlink -f "$USER_HOME" 2>/dev/null || realpath "$USER_HOME" 2>/dev/null || echo "$USER_HOME")"',
      'if [[ ! -d "$WORKSPACE" ]]; then',
      '  exec "$REAL_SHELL" -c "$CMD"',
      "fi",
      'if [[ ! -d "$USER_HOME" ]]; then',
      '  USER_HOME="$WORKSPACE"',
      "fi",
      'NPM_CACHE_DIR="${WORKSPACE}/.npm-cache"',
      'NPM_PREFIX_DIR="${WORKSPACE}/.npm-global"',
      'NPM_USERCONFIG="${WORKSPACE}/.npmrc"',
      'mkdir -p "$NPM_CACHE_DIR" "$NPM_PREFIX_DIR/bin"',
      "",
      'cd "$WORKSPACE"',
      'export PATH="$NPM_PREFIX_DIR/bin:$PATH_DEFAULT"',
      'export HOME="$USER_HOME"',
      'export USER="$USER_NAME"',
      'export LOGNAME="$USER_NAME"',
      'export SHELL="$REAL_SHELL"',
      'export TERM="${TERM:-xterm-256color}"',
      'export LANG="${LANG:-C.UTF-8}"',
      'export NPM_CONFIG_CACHE="$NPM_CACHE_DIR"',
      'export npm_config_cache="$NPM_CACHE_DIR"',
      'export NPM_CONFIG_PREFIX="$NPM_PREFIX_DIR"',
      'export npm_config_prefix="$NPM_PREFIX_DIR"',
      'export NPM_CONFIG_USERCONFIG="$NPM_USERCONFIG"',
      'export npm_config_userconfig="$NPM_USERCONFIG"',
      'export NPM_CONFIG_UPDATE_NOTIFIER=false',
      'export npm_config_update_notifier=false',
      'if [[ -n "$NODE_BIN" ]]; then',
      '  export TFCLAW_EXEC_NODE_PATH="$NODE_BIN"',
      "fi",
      "",
      "# Guardrail: rewrite common bad node invocations that bypass configured nodePath.",
      'if [[ -n "$NODE_BIN" ]]; then',
      '  CMD="${CMD//\\/usr\\/bin\\/node/node}"',
      '  CMD="${CMD//\\/usr\\/local\\/bin\\/node/node}"',
      '  CMD="${CMD//env -i \\/bin\\/bash -lc/env -i bash -lc}"',
      '  CMD="${CMD//env -i \\/usr\\/bin\\/bash -lc/env -i bash -lc}"',
      '  if [[ "$CMD" == *"env -i "* && "$CMD" != *"env -i PATH="* ]]; then',
      '    CMD="${CMD//env -i /env -i PATH=\\"$PATH\\" }"',
      "  fi",
      "fi",
      'exec "$REAL_SHELL" -lc "$CMD"',
    ].join("\n");
  }

  private loadBaseOpenClawConfig(): Record<string, unknown> {
    const templatePath = this.config.configTemplatePath.trim();
    if (!templatePath) {
      return {};
    }
    const absPath = path.resolve(templatePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`openclaw config template not found: ${absPath}`);
    }
    try {
      return toObject(JSON.parse(fs.readFileSync(absPath, "utf8")));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse openclaw config template (${absPath}): ${msg}`);
    }
  }

  private prepareUserRuntime(binding: OpenClawResolvedUserBinding, workspaceOverrideDir?: string): {
    sessionName: string;
    startCommand: string;
    workspaceConstDeclaration: string;
    workspaceDir: string;
  } {
    const runtimeDir = this.userRuntimeDir(binding);
    const privateWorkspaceDir = this.userDefaultWorkspaceDir(binding);
    const privateWorkspaceSkillsDir = path.join(privateWorkspaceDir, "skills");
    const workspaceDir = workspaceOverrideDir?.trim()
      ? path.resolve(workspaceOverrideDir.trim())
      : privateWorkspaceDir;
    const workspaceSkillsDir = path.join(workspaceDir, "skills");
    const agentsDir = path.join(runtimeDir, "agents");
    const shellWrapperDir = path.join(runtimeDir, "bin");
    const shellWrapperPath = path.join(shellWrapperDir, "tfclaw-jail-shell.sh");
    const skillsDir = path.join(binding.account.home, "skills");
    const openclawStateDir = path.join(binding.account.home, ".openclaw");
    const workspaceConstRuntimePath = path.join(runtimeDir, "WORKDIR.const.js");
    const workspaceConstWorkspacePath = path.join(workspaceDir, "WORKDIR.const.js");
    const shouldSeedPrivateWorkspace = this.shouldSeedPrivateWorkspace(privateWorkspaceDir);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(privateWorkspaceDir, { recursive: true });
    if (shouldSeedPrivateWorkspace) {
      this.initializePrivateWorkspace(binding, privateWorkspaceDir);
    }
    fs.mkdirSync(privateWorkspaceSkillsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(workspaceSkillsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(shellWrapperDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(openclawStateDir, { recursive: true });
    const workspaceConstDeclaration = this.buildWorkspaceConstDeclaration(workspaceDir);
    fs.writeFileSync(workspaceConstRuntimePath, `${workspaceConstDeclaration}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.writeFileSync(workspaceConstWorkspacePath, `${workspaceConstDeclaration}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const envState = this.loadUserPrivateEnvVars(binding);
    const runtimeEnvVars = this.loadRuntimeEnvVars(binding, workspaceDir, envState.vars);
    const configPath = path.join(runtimeDir, "openclaw.json");
    const existingConfig = this.readJsonObjectFile(configPath);
    const templateConfig = this.loadBaseOpenClawConfig();
    const baseConfig = Object.keys(existingConfig).length > 0 ? existingConfig : templateConfig;
    const configObj = this.preserveOpenClawManagedConfigFields(
      this.buildOpenClawConfig(baseConfig, binding, workspaceDir, runtimeEnvVars),
      existingConfig,
    );

    if (this.shouldRewriteOpenClawConfig(configPath, configObj)) {
      fs.writeFileSync(configPath, `${JSON.stringify(configObj, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    fs.writeFileSync(shellWrapperPath, `${this.buildExecJailShellScript()}\n`, {
      encoding: "utf8",
      mode: 0o700,
    });
    this.writeExecApprovalsForUser(binding);
    this.ensurePathOwnerAndMode(binding.account.home, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(runtimeDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(privateWorkspaceDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(privateWorkspaceSkillsDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(workspaceDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(workspaceSkillsDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(agentsDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(shellWrapperDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(shellWrapperPath, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(skillsDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(openclawStateDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(configPath, binding.account.uid, binding.account.gid, 0o600);
    this.ensurePathOwnerAndMode(workspaceConstRuntimePath, binding.account.uid, binding.account.gid, 0o600);
    this.ensurePathOwnerAndMode(workspaceConstWorkspacePath, binding.account.uid, binding.account.gid, 0o600);

    const nodePath = path.resolve(this.config.nodePath || process.execPath);
    const nodeBinDir = path.dirname(nodePath);
    const startCommand = [
      "umask 077",
      `cd ${shellQuote(this.config.openclawRoot)}`,
      `HOME=${shellQuote(binding.account.home)} USER=${shellQuote(binding.account.username)} LOGNAME=${shellQuote(binding.account.username)} SHELL=${shellQuote(shellWrapperPath)} TFCLAW_EXEC_WORKSPACE=${shellQuote(workspaceDir)} TFCLAW_EXEC_HOME=${shellQuote(binding.account.home)} TFCLAW_EXEC_REAL_SHELL='/bin/bash' TFCLAW_EXEC_NODE_BIN_DIR=${shellQuote(nodeBinDir)} NODE_DISABLE_COMPILE_CACHE=1 OPENCLAW_HOME=${shellQuote(binding.account.home)} CLAWHUB_WORKDIR=${shellQuote(envState.vars.CLAWHUB_WORKDIR || privateWorkspaceDir)} OPENCLAW_CONFIG_PATH=${shellQuote(configPath)} OPENCLAW_GATEWAY_TOKEN=${shellQuote(binding.gatewayToken)} exec ${shellQuote(nodePath)} ${shellQuote(this.openclawEntryPath)} gateway --allow-unconfigured --port ${binding.gatewayPort} --bind loopback --auth token --token ${shellQuote(binding.gatewayToken)}`,
    ].join(" && ");

    const sessionRaw = `${this.config.tmuxSessionPrefix}${binding.account.username}`;
    const sessionName = sanitizeTmuxName(sessionRaw) || `openclaw_${binding.account.username}`;
    return {
      sessionName,
      startCommand,
      workspaceConstDeclaration,
      workspaceDir,
    };
  }

  private async ensureTmuxOpenClawProcess(
    binding: OpenClawResolvedUserBinding,
    runtime: { sessionName: string; startCommand: string },
    options?: { forceRestart?: boolean },
  ): Promise<void> {
    const forceRestart = options?.forceRestart === true;
    const portAlreadyOpen = await this.isPortOpen(this.config.gatewayHost, binding.gatewayPort);
    if (!forceRestart && portAlreadyOpen) {
      return;
    }

    const hasSession = await this.runAsUser(binding.account.username, "tmux", [
      "has-session",
      "-t",
      runtime.sessionName,
    ]);
    if (hasSession.code === 0) {
      await this.runAsUser(binding.account.username, "tmux", [
        "kill-session",
        "-t",
        runtime.sessionName,
      ]);
    }

    if (forceRestart) {
      await this.killOpenClawGatewayProcessesForUser(binding.account.username);
      const closed = await this.waitForPortClosed(
        this.config.gatewayHost,
        binding.gatewayPort,
        Math.min(10_000, this.config.startupTimeoutMs),
      );
      if (!closed) {
        throw new Error(
          `openclaw process for ${binding.account.username} is still listening on ${this.config.gatewayHost}:${binding.gatewayPort} after restart cleanup`,
        );
      }
    } else if (portAlreadyOpen) {
      throw new Error(
        `openclaw process for ${binding.account.username} is listening on ${this.config.gatewayHost}:${binding.gatewayPort}, but tmux session ${runtime.sessionName} is missing`,
      );
    }

    const started = await this.runAsUser(
      binding.account.username,
      "tmux",
      ["new-session", "-d", "-s", runtime.sessionName, "bash", "-lc", runtime.startCommand],
      { timeoutMs: 10_000 },
    );
    if (started.code !== 0) {
      throw new Error(
        `failed to start tmux session for ${binding.account.username}: ${started.stderr.trim() || "unknown error"}`,
      );
    }

    const ready = await this.waitForPortOpen(
      this.config.gatewayHost,
      binding.gatewayPort,
      this.config.startupTimeoutMs,
    );
    if (ready) {
      return;
    }

    const pane = await this.runAsUser(binding.account.username, "tmux", [
      "capture-pane",
      "-p",
      "-t",
      `${runtime.sessionName}:0.0`,
    ]);
    const tail = pane.stdout.trim().split(/\r?\n/).slice(-20).join("\n");
    throw new Error(
      `openclaw gateway did not become ready on ${this.config.gatewayHost}:${binding.gatewayPort}. tmux tail:\n${tail || "(empty)"}`,
    );
  }

  private extractChatText(message: unknown): string {
    const obj = toObject(message);
    const directText = toString(obj.text).trim();
    if (directText) {
      return directText;
    }
    const content = obj.content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      return "";
    }
    const lines: string[] = [];
    for (const item of content) {
      const block = toObject(item);
      const type = toString(block.type).trim().toLowerCase();
      if (type !== "text") {
        continue;
      }
      const text = toString(block.text).trim();
      if (text) {
        lines.push(text);
      }
    }
    return lines.join("\n").trim();
  }

  private unwrapMediaCandidate(raw: string): string {
    return raw
      .trim()
      .replace(/^`(.+)`$/, "$1")
      .replace(/^"(.+)"$/, "$1")
      .replace(/^'(.+)'$/, "$1")
      .trim();
  }

  private hasLikelyAttachmentExtension(candidate: string): boolean {
    const value = this.unwrapMediaCandidate(candidate);
    if (!value) {
      return false;
    }
    const withoutQuery = value.split(/[?#]/)[0] ?? value;
    const ext = path.extname(withoutQuery).trim().toLowerCase();
    if (!ext) {
      return false;
    }
    return OPENCLAW_BRIDGE_HEURISTIC_ATTACHMENT_EXTENSIONS.has(ext);
  }

  private extractAttachmentReferenceFromLine(rawLine: string): string {
    const line = rawLine.trim();
    if (!line) {
      return "";
    }
    let candidate = line
      .replace(/^(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?/, "")
      .replace(/^(?:📎|附件|attachment|file|media)\s*[:：]?\s*/i, "")
      .trim();
    // Normalize placeholder variants like "📎 MEDIA:/tmp/xxx.mp3".
    candidate = candidate.replace(/^media\s*[:：]?\s*/i, "").trim();
    candidate = this.unwrapMediaCandidate(candidate);
    if (!candidate) {
      return "";
    }
    if (!this.looksLikeMediaReference(candidate, { enforceAttachmentExtension: true })) {
      return "";
    }
    return candidate;
  }

  private looksLikeMediaReference(
    candidate: string,
    options?: { enforceAttachmentExtension?: boolean },
  ): boolean {
    const value = this.unwrapMediaCandidate(candidate);
    if (!value) {
      return false;
    }
    const enforceAttachmentExtension = Boolean(options?.enforceAttachmentExtension);
    if (/^data:[^;,]+;base64,/i.test(value)) {
      return true;
    }
    if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) {
      if (enforceAttachmentExtension) {
        return this.hasLikelyAttachmentExtension(value);
      }
      return true;
    }
    if (/^~\//.test(value)) {
      return !enforceAttachmentExtension || this.hasLikelyAttachmentExtension(value);
    }
    if (/^(?:\/|\.{1,2}\/)/.test(value)) {
      return !enforceAttachmentExtension || this.hasLikelyAttachmentExtension(value);
    }
    if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
      return !enforceAttachmentExtension || this.hasLikelyAttachmentExtension(value);
    }
    const plainFileName = /^[^\\/:*?"<>|\r\n]+\.[a-zA-Z0-9]{1,10}(?:[?#].*)?$/.test(value);
    if (!plainFileName) {
      return false;
    }
    if (!enforceAttachmentExtension) {
      return true;
    }
    return this.hasLikelyAttachmentExtension(value);
  }

  private parseMediaDirectivesFromText(text: string): { text: string; mediaRefs: string[]; audioAsVoice: boolean } {
    if (!text.trim()) {
      return { text: "", mediaRefs: [], audioAsVoice: false };
    }
    const keptLines: string[] = [];
    const mediaRefs: string[] = [];
    let audioAsVoice = false;
    const inlinePattern = /^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?(?:📎\s*)?MEDIA(?:\s*[:：]\s*|\s+)(.+)\s*$/i;
    const markerPattern = /^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?(?:📎\s*)?MEDIA\s*[:：]?\s*$/i;
    const audioVoiceMarkerPattern = /^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?\[\[\s*audio_as_voice\s*\]\]\s*$/i;
    const listValuePattern = /^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?(.+?)\s*$/;
    let awaitingValue = false;
    let inFence = false;

    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (/^(?:```|~~~)/.test(trimmed)) {
        inFence = !inFence;
        awaitingValue = false;
        keptLines.push(rawLine);
        continue;
      }
      if (inFence) {
        keptLines.push(rawLine);
        continue;
      }

      if (audioVoiceMarkerPattern.test(rawLine)) {
        audioAsVoice = true;
        awaitingValue = false;
        continue;
      }

      const inline = rawLine.match(inlinePattern);
      if (inline) {
        const candidate = this.unwrapMediaCandidate(inline[1] ?? "");
        if (this.looksLikeMediaReference(candidate, { enforceAttachmentExtension: true })) {
          mediaRefs.push(candidate);
          awaitingValue = false;
          continue;
        }
        if (!candidate) {
          awaitingValue = true;
          continue;
        }
        keptLines.push(rawLine);
        awaitingValue = false;
        continue;
      }

      if (markerPattern.test(rawLine)) {
        awaitingValue = true;
        continue;
      }

      if (awaitingValue) {
        if (!trimmed) {
          continue;
        }
        const listCandidate = listValuePattern.exec(rawLine)?.[1] ?? "";
        const normalized = this.unwrapMediaCandidate(listCandidate);
        if (this.looksLikeMediaReference(normalized, { enforceAttachmentExtension: true })) {
          mediaRefs.push(normalized);
          continue;
        }
        awaitingValue = false;
      }

      const attachmentRef = this.extractAttachmentReferenceFromLine(rawLine);
      if (attachmentRef) {
        mediaRefs.push(attachmentRef);
        awaitingValue = false;
        continue;
      }

      keptLines.push(rawLine);
    }
    return {
      text: keptLines.join("\n").trim(),
      mediaRefs: Array.from(new Set(mediaRefs)),
      audioAsVoice,
    };
  }

  private extractMediaReferencesFromMessage(message: unknown): string[] {
    const obj = toObject(message);
    const refs: string[] = [];
    const singularKeys = [
      "mediaUrl",
      "path",
      "filePath",
      "fileUrl",
      "imageUrl",
      "audioUrl",
      "videoUrl",
    ];
    const pluralKeys = [
      "mediaUrls",
      "paths",
      "filePaths",
      "fileUrls",
      "imageUrls",
      "audioUrls",
      "videoUrls",
    ];
    const nestedKeys = ["content", "attachments", "details", "payload", "message", "media", "files"];

    const collectFromRecord = (record: Record<string, unknown>): void => {
      for (const key of singularKeys) {
        const value = this.unwrapMediaCandidate(toString(record[key]).trim());
        if (value && this.looksLikeMediaReference(value, { enforceAttachmentExtension: true })) {
          refs.push(value);
        }
      }
      for (const key of pluralKeys) {
        const raw = record[key];
        if (!Array.isArray(raw)) {
          continue;
        }
        for (const item of raw) {
          const value = this.unwrapMediaCandidate(toString(item).trim());
          if (value && this.looksLikeMediaReference(value, { enforceAttachmentExtension: true })) {
            refs.push(value);
          }
        }
      }
    };

    const walk = (value: unknown, depth: number): void => {
      if (depth > 3 || value == null) {
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, depth + 1);
        }
        return;
      }
      if (typeof value !== "object") {
        return;
      }
      const record = toObject(value);
      collectFromRecord(record);
      for (const key of nestedKeys) {
        if (record[key] !== undefined) {
          walk(record[key], depth + 1);
        }
      }
    };

    walk(obj, 0);
    return Array.from(new Set(refs));
  }

  private isLikelyBase64(value: string): boolean {
    const compact = value.replace(/\s+/g, "");
    if (!compact || compact.length % 4 !== 0) {
      return false;
    }
    return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  }

  private parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | undefined {
    const matched = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
    if (!matched) {
      return undefined;
    }
    const mimeType = this.normalizeMimeType(matched[1] ?? "");
    const base64 = (matched[2] ?? "").replace(/\s+/g, "");
    if (!this.isLikelyBase64(base64)) {
      return undefined;
    }
    return { mimeType, base64 };
  }

  private extractDirectMediaFromMessage(message: unknown): OpenClawBridgeMediaItem[] {
    const obj = toObject(message);
    if (!Array.isArray(obj.content)) {
      return [];
    }

    const result: OpenClawBridgeMediaItem[] = [];
    for (const item of obj.content) {
      const block = toObject(item);
      const type = toString(block.type).trim().toLowerCase();
      if (!type || (type !== "image" && type !== "file" && type !== "media" && type !== "audio")) {
        continue;
      }
      const rawData = toString(block.data, toString(block.base64, toString(block.content))).trim();
      if (!rawData) {
        continue;
      }

      let contentBase64 = rawData.replace(/\s+/g, "");
      let mimeType = this.normalizeMimeType(
        toString(block.mimeType, toString(block.mime, toString(block.contentType))),
      );
      if (rawData.startsWith("data:")) {
        const parsed = this.parseDataUrl(rawData);
        if (!parsed) {
          continue;
        }
        contentBase64 = parsed.base64;
        mimeType = parsed.mimeType;
      } else if (!this.isLikelyBase64(contentBase64)) {
        continue;
      }

      const fileName = this.sanitizeAttachmentFileName(
        toString(block.fileName, toString(block.name, `${type}-${Date.now()}`)),
        type || "media",
      );
      const isImage = type === "image" || this.isImageMimeType(mimeType);
      result.push({
        kind: isImage ? "image" : "file",
        fileName,
        mimeType: mimeType || this.inferMimeTypeFromFileName(fileName),
        contentBase64,
        source: "gateway-message-block",
      });
    }
    return result;
  }

  private dedupeMediaItems(items: OpenClawBridgeMediaItem[]): OpenClawBridgeMediaItem[] {
    const seen = new Set<string>();
    const out: OpenClawBridgeMediaItem[] = [];
    for (const item of items) {
      const key = `${item.kind}::${item.fileName}::${item.contentBase64.slice(0, 64)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  private normalizeMediaReference(raw: string): string {
    return raw
      .trim()
      .replace(/^`(.+)`$/, "$1")
      .replace(/^"(.+)"$/, "$1")
      .replace(/^'(.+)'$/, "$1")
      .trim();
  }

  private isPathInsideRoot(targetPath: string, rootPath: string): boolean {
    const target = path.resolve(targetPath);
    const root = path.resolve(rootPath);
    if (target === root) {
      return true;
    }
    return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  }

  private resolveLocalMediaPath(reference: string, workspaceDir: string, homeDir: string): string {
    const normalized = this.normalizeMediaReference(reference);
    if (!normalized) {
      throw new Error("empty media reference");
    }
    if (normalized.startsWith("file://")) {
      try {
        return decodeURIComponent(new URL(normalized).pathname);
      } catch {
        throw new Error(`invalid file url: ${normalized}`);
      }
    }
    if (normalized.startsWith("~/")) {
      return path.join(homeDir, normalized.slice(2));
    }
    if (path.isAbsolute(normalized)) {
      return normalized;
    }
    return path.resolve(workspaceDir, normalized);
  }

  private async loadMediaFromReference(
    reference: string,
    options: { workspaceDir: string; homeDir: string; extraRoots?: string[] },
  ): Promise<OpenClawBridgeMediaItem> {
    const normalized = this.normalizeMediaReference(reference);
    if (!normalized) {
      throw new Error("empty media reference");
    }

    if (normalized.startsWith("data:")) {
      const parsed = this.parseDataUrl(normalized);
      if (!parsed) {
        throw new Error("invalid data url media reference");
      }
      const fileName = this.sanitizeAttachmentFileName(
        `inline.${this.isImageMimeType(parsed.mimeType) ? "png" : "bin"}`,
        "inline-media",
      );
      return {
        kind: this.isImageMimeType(parsed.mimeType) ? "image" : "file",
        fileName,
        mimeType: parsed.mimeType || this.inferMimeTypeFromFileName(fileName),
        contentBase64: parsed.base64,
        source: "data-url",
      };
    }

    if (/^https?:\/\//i.test(normalized)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPENCLAW_BRIDGE_MEDIA_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(normalized, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`http ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.byteLength === 0) {
          throw new Error("empty body");
        }
        if (buffer.byteLength > OPENCLAW_BRIDGE_OUTBOUND_MAX_FILE_BYTES) {
          throw new Error(`file too large: ${buffer.byteLength} bytes`);
        }
        let fileName = "downloaded-media.bin";
        try {
          const parsedUrl = new URL(normalized);
          const fromPath = path.basename(parsedUrl.pathname || "");
          if (fromPath) {
            fileName = fromPath;
          }
        } catch {
          // no-op
        }
        const safeName = this.sanitizeAttachmentFileName(fileName, "downloaded-media");
        const headerMimeType = this.normalizeMimeType(response.headers.get("content-type") ?? "");
        const mimeType = headerMimeType === "application/octet-stream"
          ? this.inferMimeTypeFromFileName(safeName)
          : headerMimeType;
        return {
          kind: this.isImageMimeType(mimeType) ? "image" : "file",
          fileName: safeName,
          mimeType,
          contentBase64: buffer.toString("base64"),
          source: normalized,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    const resolved = this.resolveLocalMediaPath(normalized, options.workspaceDir, options.homeDir);
    const allowedRoots = [
      options.workspaceDir,
      options.homeDir,
      ...(options.extraRoots ?? []),
    ]
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item));
    if (!allowedRoots.some((root) => this.isPathInsideRoot(resolved, root))) {
      throw new Error(`local media path outside user scope: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`not a file: ${resolved}`);
    }
    if (stat.size <= 0) {
      throw new Error(`empty file: ${resolved}`);
    }
    if (stat.size > OPENCLAW_BRIDGE_OUTBOUND_MAX_FILE_BYTES) {
      throw new Error(`file too large: ${stat.size} bytes`);
    }
    const buffer = fs.readFileSync(resolved);
    const fileName = this.sanitizeAttachmentFileName(path.basename(resolved), "media");
    const mimeType = this.inferMimeTypeFromFileName(fileName);
    return {
      kind: this.isImageMimeType(mimeType) ? "image" : "file",
      fileName,
      mimeType,
      contentBase64: buffer.toString("base64"),
      source: resolved,
    };
  }

  private async resolveMediaReferences(
    refs: string[],
    options: { workspaceDir: string; homeDir: string; extraRoots?: string[] },
  ): Promise<OpenClawBridgeMediaItem[]> {
    const items: OpenClawBridgeMediaItem[] = [];
    for (const reference of Array.from(new Set(refs))) {
      try {
        const media = await this.loadMediaFromReference(reference, options);
        items.push(media);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[gateway] openclaw media bridge skip ${reference}: ${msg}`);
      }
    }
    return items;
  }

  private extractLooseLocalMediaReferences(
    rawText: string,
    options: { workspaceDir: string; homeDir: string; extraRoots?: string[] },
  ): string[] {
    const refs = new Set<string>();
    const pattern = /(?:^|[\s(])((?:file:\/\/|~\/|\/)[^\s<>"')\]]+)/g;
    for (const match of rawText.matchAll(pattern)) {
      const candidate = this.unwrapMediaCandidate(match[1] ?? "");
      if (!candidate || !this.looksLikeMediaReference(candidate, { enforceAttachmentExtension: true })) {
        continue;
      }
      try {
        const resolved = this.resolveLocalMediaPath(candidate, options.workspaceDir, options.homeDir);
        const allowedRoots = [
          options.workspaceDir,
          options.homeDir,
          ...(options.extraRoots ?? []),
        ]
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => path.resolve(item));
        if (!allowedRoots.some((root) => this.isPathInsideRoot(resolved, root))) {
          continue;
        }
        const stat = fs.statSync(resolved);
        if (stat.isFile() && stat.size > 0) {
          refs.add(candidate);
        }
      } catch {
        // no-op
      }
    }
    return Array.from(refs);
  }

  private listRecentFilesUnder(
    rootDir: string,
    options?: {
      maxCount?: number;
      maxDirs?: number;
      modifiedAfterMs?: number;
      excludeDirs?: string[];
      excludeDirNames?: string[];
    },
  ): string[] {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return [];
    }
    const maxCount = Math.max(1, options?.maxCount ?? 40);
    const maxDirs = Math.max(1, options?.maxDirs ?? 200);
    const modifiedAfterMs = options?.modifiedAfterMs;
    const excludeDirs = (options?.excludeDirs ?? []).map((item) => path.resolve(item));
    const excludeDirNames = new Set((options?.excludeDirNames ?? []).map((item) => item.toLowerCase()));
    const stack = [rootDir];
    const files: Array<{ filePath: string; mtimeMs: number }> = [];
    let scannedDirs = 0;

    while (stack.length > 0 && scannedDirs < maxDirs) {
      const currentDir = stack.pop() ?? "";
      if (!currentDir) {
        continue;
      }
      if (
        excludeDirs.some((dir) =>
          this.isPathInsideRoot(path.resolve(currentDir), dir)
        )
      ) {
        continue;
      }
      scannedDirs += 1;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (excludeDirNames.has(entry.name.toLowerCase())) {
            continue;
          }
          stack.push(candidate);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(candidate);
        } catch {
          stat = undefined;
        }
        if (!stat || !stat.isFile()) {
          continue;
        }
        if (typeof modifiedAfterMs === "number" && Number.isFinite(modifiedAfterMs) && stat.mtimeMs < modifiedAfterMs) {
          continue;
        }
        files.push({
          filePath: candidate,
          mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
        });
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, maxCount).map((item) => item.filePath);
  }

  private async resolveMediaPlaceholderFallback(
    rawText: string,
    options: {
      workspaceDir: string;
      homeDir: string;
      extraRoots?: string[];
      runStartedAtMs?: number;
      allowEmptyMarkerFallback?: boolean;
    },
  ): Promise<OpenClawBridgeMediaItem[]> {
    const marker = rawText.match(/^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?MEDIA\s*[:：]?\s*([^\n]*)\s*$/im);
    if (!marker) {
      return [];
    }
    const markerValue = this.unwrapMediaCandidate(marker[1] ?? "");
    const isEmptyMarker = markerValue.length === 0;
    if (markerValue && this.looksLikeMediaReference(markerValue, { enforceAttachmentExtension: true })) {
      try {
        return [await this.loadMediaFromReference(markerValue, options)];
      } catch {
        // Continue to inbound fallback.
      }
    }
    if (isEmptyMarker && !options.allowEmptyMarkerFallback) {
      return [];
    }

    const candidateRoots = Array.from(
      new Set([
        path.join(options.workspaceDir, "outbound"),
        path.join(options.workspaceDir, "media"),
        ...(isEmptyMarker ? [options.workspaceDir] : [path.join(options.workspaceDir, "skills"), path.join(options.homeDir, "skills")]),
      ]),
    );
    const scanOptions = {
      maxCount: 120,
      maxDirs: 400,
      modifiedAfterMs: typeof options.runStartedAtMs === "number"
        ? Math.max(0, options.runStartedAtMs - 30_000)
        : undefined,
      excludeDirs: markerValue ? [] : [path.join(options.workspaceDir, "inbound")],
      excludeDirNames: [".git", "node_modules"],
    };
    let recentFiles = candidateRoots.flatMap((rootDir) => this.listRecentFilesUnder(rootDir, scanOptions));
    // For empty MEDIA markers, only consider files created/updated around this run.
    // Avoid falling back to historical files from older sessions.
    if (!isEmptyMarker && recentFiles.length === 0 && typeof scanOptions.modifiedAfterMs === "number") {
      recentFiles = candidateRoots.flatMap((rootDir) =>
        this.listRecentFilesUnder(rootDir, { ...scanOptions, modifiedAfterMs: undefined }));
    }
    recentFiles = Array.from(new Set(recentFiles)).filter((candidate) =>
      (this.isPathInsideRoot(candidate, options.workspaceDir)
        || this.isPathInsideRoot(candidate, options.homeDir)
        || (options.extraRoots ?? []).some((root) => this.isPathInsideRoot(candidate, root)))
      && this.looksLikeMediaReference(candidate, { enforceAttachmentExtension: true }));
    recentFiles = recentFiles
      .map((candidate) => {
        try {
          const stat = fs.statSync(candidate);
          return {
            candidate,
            mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
          };
        } catch {
          return undefined;
        }
      })
      .filter((item): item is { candidate: string; mtimeMs: number } => Boolean(item))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((item) => item.candidate);
    if (recentFiles.length === 0) {
      return [];
    }

    let target = "";
    const normalizedMarker = markerValue
      .replace(/^[./]+/, "")
      .replace(/\\/g, "/")
      .toLowerCase();
    if (normalizedMarker) {
      const matched = recentFiles.find((candidate) => {
        const rel = path.relative(options.workspaceDir, candidate).replace(/\\/g, "/").toLowerCase();
        const base = path.basename(candidate).toLowerCase();
        return (
          rel.startsWith(normalizedMarker)
          || rel.endsWith(normalizedMarker)
          || base === normalizedMarker
          || base.startsWith(normalizedMarker)
        );
      });
      if (matched) {
        target = matched;
      }
    }
    // When caller provides an explicit MEDIA value but it cannot be resolved,
    // do not fall back to arbitrary "latest file" to avoid wrong-file sends.
    if (!target) {
      if (isEmptyMarker && options.allowEmptyMarkerFallback) {
        target = recentFiles[0] ?? "";
      }
    }
    if (!target) {
      return [];
    }

    if (!target) {
      return [];
    }
    try {
      return [await this.loadMediaFromReference(target, options)];
    } catch {
      return [];
    }
  }

  private resolveOpenClawSessionFile(
    sessionKey: string,
    homeDir: string,
  ): string {
    const sessionsIndexPath = path.join(homeDir, ".openclaw", "agents", "main", "sessions", "sessions.json");
    if (!fs.existsSync(sessionsIndexPath)) {
      return "";
    }
    try {
      const raw = JSON.parse(fs.readFileSync(sessionsIndexPath, "utf8")) as Record<string, unknown>;
      const entry = toObject(raw?.[sessionKey]);
      const sessionFile = toString(entry.sessionFile).trim();
      if (sessionFile) {
        return sessionFile;
      }
      const sessionId = toString(entry.sessionId).trim();
      if (!sessionId) {
        return "";
      }
      return path.join(path.dirname(sessionsIndexPath), `${sessionId}.jsonl`);
    } catch {
      return "";
    }
  }

  private extractLatestAssistantMediaRefsFromSession(
    sessionFile: string,
    options: {
      runStartedAtMs: number;
      workspaceDir: string;
      homeDir: string;
      extraRoots?: string[];
    },
  ): string[] {
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      return [];
    }
    try {
      const stat = fs.statSync(sessionFile);
      if (Number.isFinite(stat.mtimeMs) && stat.mtimeMs < options.runStartedAtMs - 60_000) {
        return [];
      }
      const lines = fs.readFileSync(sessionFile, "utf8").split(/\r?\n/).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
        const message = toObject(parsed?.message);
        if (toString(message.role).trim().toLowerCase() !== "assistant") {
          continue;
        }
        const timestamp = Number(message.timestamp);
        if (Number.isFinite(timestamp) && timestamp < options.runStartedAtMs - 60_000) {
          break;
        }
        const rawText = this.extractChatText(message);
        if (!rawText) {
          continue;
        }
        // Session fallback must only recover explicit MEDIA directives from the
        // current assistant turn. Do not scan loosely for "recent files", or we
        // may send a stale markdown/memory artifact from an older request.
        const refs = Array.from(new Set([
          ...this.parseMediaDirectivesFromText(rawText).mediaRefs,
          ...this.extractMediaReferencesFromMessage(message),
        ]));
        if (refs.length > 0) {
          return refs;
        }
      }
    } catch {
      return [];
    }
    return [];
  }

  private getOrCreateGatewayOperatorIdentity(cacheKey: string): OpenClawGatewayOperatorIdentity {
    const cached = this.gatewayOperatorIdentityByCacheKey.get(cacheKey);
    if (cached) {
      return cached;
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = deriveEd25519PublicKeyRawFromPem(publicKeyPem);
    const identity: OpenClawGatewayOperatorIdentity = {
      deviceId: createHash("sha256").update(publicKeyRaw).digest("hex"),
      publicKeyRawBase64Url: encodeBase64Url(publicKeyRaw),
      privateKeyPem,
    };
    this.gatewayOperatorIdentityByCacheKey.set(cacheKey, identity);
    return identity;
  }

  private signGatewayDevicePayload(privateKeyPem: string, payload: string): string {
    const key = createPrivateKey(privateKeyPem);
    const signature = cryptoSign(null, Buffer.from(payload, "utf8"), key);
    return encodeBase64Url(signature);
  }

  private formatFrameError(frame: Record<string, unknown>): string {
    const error = toObject(frame.error);
    const message = toString(error.message).trim();
    if (message) {
      return message;
    }
    const code = toString(error.code).trim();
    if (code) {
      return `gateway error: ${code}`;
    }
    return "gateway request failed";
  }

  private buildPermissionDeniedReply(...values: unknown[]): string | undefined {
    const raw = values
      .map((value) => {
        if (typeof value === "string") {
          return value;
        }
        try {
          return JSON.stringify(value);
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n");
    const lowered = raw.toLowerCase();
    if (
      lowered.includes("permission denied")
      || lowered.includes("no permission")
      || lowered.includes("forbidden")
      || lowered.includes("unauthorized")
      || raw.includes("没有权限")
      || raw.includes("无权限")
      || raw.includes("权限不足")
    ) {
      return "操作失败：没有相关权限。请检查当前账号或应用是否具备所需权限。";
    }
    return undefined;
  }

  private buildEmptyReplyFallback(...values: unknown[]): string {
    const permissionReply = this.buildPermissionDeniedReply(...values);
    if (permissionReply) {
      return permissionReply;
    }
    return "OpenClaw 本轮没有返回可发送内容。常见原因是工具调用失败、权限不足，或本轮没有生成可发送文本。";
  }

  private isUnsupportedChatSendParamError(message: string): boolean {
    const lowered = (message || "").toLowerCase();
    if (!lowered.includes("invalid chat.send params") || !lowered.includes("unexpected property")) {
      return false;
    }
    return lowered.includes("messagechannel") || lowered.includes("requestersenderid");
  }

  private async callGatewayChat(params: {
    gatewayUrl: string;
    gatewayToken: string;
    sessionKey: string;
    message: string;
    messageChannel?: string;
    attachments?: Array<{ type: "image"; mimeType: string; fileName: string; content: string }>;
    workspaceDir: string;
    homeDir: string;
    extraLocalMediaRoots?: string[];
    requesterSenderId?: string;
    onDeltaText?: (text: string) => void | Promise<void>;
    allowEmptyMediaPlaceholderFallback?: boolean;
  }): Promise<OpenClawBridgeResponse> {
    return await new Promise<OpenClawBridgeResponse>((resolve, reject) => {
      const ws = new WebSocket(params.gatewayUrl);
      const connectReqId = `connect-${randomId()}`;
      const chatReqId = `chat-${randomId()}`;
      const runStartedAtMs = Date.now();
      const operatorScopes = ["operator.write", "operator.read"];
      const connectClient = {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      } as const;
      const connectIdentityCacheKey = `${params.gatewayUrl}|${params.gatewayToken}`;
      let closed = false;
      let connectSent = false;
      let runId = "";
      let lastDelta = "";
      let lastAssistantText = "";
      let lastMediaRefs: string[] = [];
      let lastDirectMedia: OpenClawBridgeMediaItem[] = [];
      let lastAudioAsVoice = false;
      let connectFallbackTimer: NodeJS.Timeout | undefined;

      const sendConnectRequest = (nonce?: string): void => {
        if (connectSent) {
          return;
        }
        connectSent = true;
        if (connectFallbackTimer) {
          clearTimeout(connectFallbackTimer);
          connectFallbackTimer = undefined;
        }
        const connectParams: Record<string, unknown> = {
          minProtocol: 1,
          maxProtocol: 99,
          client: connectClient,
          role: "operator",
          scopes: operatorScopes,
          caps: [],
          auth: params.gatewayToken ? { token: params.gatewayToken } : undefined,
        };
        if (nonce && params.gatewayToken) {
          const identity = this.getOrCreateGatewayOperatorIdentity(connectIdentityCacheKey);
          const signedAt = Date.now();
          const signedPayload = buildGatewayDeviceAuthPayloadV3({
            deviceId: identity.deviceId,
            clientId: connectClient.id,
            clientMode: connectClient.mode,
            role: "operator",
            scopes: operatorScopes,
            signedAtMs: signedAt,
            token: params.gatewayToken,
            nonce,
            platform: connectClient.platform,
          });
          connectParams.device = {
            id: identity.deviceId,
            publicKey: identity.publicKeyRawBase64Url,
            signature: this.signGatewayDevicePayload(identity.privateKeyPem, signedPayload),
            signedAt,
            nonce,
          };
        }
        ws.send(JSON.stringify({
          type: "req",
          id: connectReqId,
          method: "connect",
          params: connectParams,
        }));
      };

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearTimeout(timer);
        if (connectFallbackTimer) {
          clearTimeout(connectFallbackTimer);
          connectFallbackTimer = undefined;
        }
        try {
          ws.close();
        } catch {
          // no-op
        }
      };

      const fail = (error: string): void => {
        const permissionReply = this.buildPermissionDeniedReply(error);
        if (permissionReply) {
          done({
            text: permissionReply,
            media: [],
            audioAsVoice: false,
          });
          return;
        }
        cleanup();
        reject(new Error(error));
      };

      const done = (reply: OpenClawBridgeResponse): void => {
        cleanup();
        resolve(reply);
      };

      const timer = setTimeout(() => {
        fail(`openclaw gateway request timeout after ${this.config.requestTimeoutMs}ms`);
      }, this.config.requestTimeoutMs);

      ws.once("open", () => {
        // Prefer signed device connect when the server provides a challenge nonce.
        connectFallbackTimer = setTimeout(() => {
          sendConnectRequest();
        }, 250);
      });

      ws.on("message", (raw) => {
        let frame: Record<string, unknown>;
        try {
          const text = typeof raw === "string" ? raw : raw.toString();
          frame = toObject(JSON.parse(text));
        } catch {
          return;
        }

        const frameType = toString(frame.type).trim().toLowerCase();
        if (!connectSent && frameType === "event") {
          const handshakeEvent = toString(frame.event).trim().toLowerCase();
          if (handshakeEvent === "connect.challenge") {
            const challengePayload = toObject(frame.payload);
            const challengeNonce = toString(challengePayload.nonce).trim();
            if (challengeNonce) {
              sendConnectRequest(challengeNonce);
              return;
            }
          }
        }
        if (frameType === "res") {
          const id = toString(frame.id).trim();
          const ok = Boolean(frame.ok);
          if (id === connectReqId) {
            if (!ok) {
              fail(`openclaw gateway connect failed: ${this.formatFrameError(frame)}`);
              return;
            }
            const chatFrame = {
              type: "req",
              id: chatReqId,
              method: "chat.send",
              params: {
                sessionKey: params.sessionKey,
                message: params.message,
                messageChannel: params.messageChannel?.trim() || undefined,
                deliver: false,
                attachments: params.attachments?.length ? params.attachments : undefined,
                timeoutMs: this.config.requestTimeoutMs,
                idempotencyKey: `tfclaw-openclaw-${randomId()}`,
                requesterSenderId: params.requesterSenderId?.trim() || undefined,
              },
            };
            ws.send(JSON.stringify(chatFrame));
            return;
          }

          if (id === chatReqId) {
            if (!ok) {
              const frameError = this.formatFrameError(frame);
              const hasExtendedParams = Boolean(params.messageChannel?.trim() || params.requesterSenderId?.trim());
              if (hasExtendedParams && this.isUnsupportedChatSendParamError(frameError)) {
                console.warn(
                  "[gateway] openclaw chat.send compatibility fallback: retry without messageChannel/requesterSenderId",
                );
                cleanup();
                this.callGatewayChat({
                  ...params,
                  messageChannel: undefined,
                  requesterSenderId: undefined,
                }).then(resolve).catch(reject);
                return;
              }
              fail(`openclaw chat.send failed: ${frameError}`);
              return;
            }
            const payload = toObject(frame.payload);
            const status = toString(payload.status).trim().toLowerCase();
            const payloadRunId = toString(payload.runId).trim();
            if (payloadRunId) {
              runId = payloadRunId;
            }
            if (status === "error") {
              const summary = toString(payload.summary).trim() || "unknown chat.send error";
              fail(`openclaw chat.send error: ${summary}`);
              return;
            }
            if (status === "ok" && !runId) {
              const summary = toString(payload.summary).trim();
              done({
                text: summary || "(openclaw run completed)",
                media: [],
                audioAsVoice: false,
              });
            }
          }
          return;
        }

        if (frameType !== "event") {
          return;
        }

        const eventName = toString(frame.event).trim().toLowerCase();
        if (eventName === "agent") {
          const payload = toObject(frame.payload);
          const payloadRunId = toString(payload.runId).trim();
          if (runId && payloadRunId && payloadRunId !== runId) {
            return;
          }
          if (!runId && payloadRunId) {
            runId = payloadRunId;
          }

          const data = toObject(payload.data);
          const dataText = toString(data.text).trim();
          if (dataText) {
            const parsedDataText = this.parseMediaDirectivesFromText(dataText);
            if (parsedDataText.text) {
              lastAssistantText = parsedDataText.text;
            }
            if (parsedDataText.audioAsVoice) {
              lastAudioAsVoice = true;
            }
            if (parsedDataText.mediaRefs.length > 0) {
              lastMediaRefs = Array.from(new Set([
                ...lastMediaRefs,
                ...parsedDataText.mediaRefs,
              ]));
            }
          }
          lastMediaRefs = Array.from(new Set([
            ...lastMediaRefs,
            ...this.extractMediaReferencesFromMessage(payload),
            ...this.extractMediaReferencesFromMessage(data),
          ]));
          return;
        }

        if (eventName !== "chat") {
          return;
        }

        const payload = toObject(frame.payload);
        const payloadRunId = toString(payload.runId).trim();
        if (runId && payloadRunId && payloadRunId !== runId) {
          return;
        }
        if (!runId && payloadRunId) {
          runId = payloadRunId;
        }

        const state = toString(payload.state).trim().toLowerCase();
        if (state === "delta") {
          const messageObj = toObject(payload.message);
          const deltaRaw = this.extractChatText(messageObj);
          if (deltaRaw) {
            const parsedDelta = this.parseMediaDirectivesFromText(deltaRaw);
            if (parsedDelta.text) {
              lastDelta = parsedDelta.text;
              if (typeof params.onDeltaText === "function") {
                void Promise.resolve(params.onDeltaText(parsedDelta.text)).catch((error) => {
                  const msg = error instanceof Error ? error.message : String(error);
                  console.warn(`[gateway] openclaw stream callback failed: ${msg}`);
                });
              }
            }
            if (parsedDelta.audioAsVoice) {
              lastAudioAsVoice = true;
            }
            if (parsedDelta.mediaRefs.length > 0) {
              lastMediaRefs = Array.from(new Set([
                ...lastMediaRefs,
                ...parsedDelta.mediaRefs,
              ]));
            }
          }
          lastMediaRefs = Array.from(new Set([
            ...lastMediaRefs,
            ...this.extractMediaReferencesFromMessage(messageObj),
          ]));
          lastDirectMedia = this.dedupeMediaItems([
            ...lastDirectMedia,
            ...this.extractDirectMediaFromMessage(messageObj),
          ]);
          return;
        }
        if (state === "final") {
          const messageObj = toObject(payload.message);
          const finalTextRaw = this.extractChatText(messageObj) || lastDelta || lastAssistantText;
          const parsedText = this.parseMediaDirectivesFromText(finalTextRaw);
          const payloadRefs = [
            ...this.extractMediaReferencesFromMessage(payload),
            ...this.extractMediaReferencesFromMessage(messageObj),
            ...parsedText.mediaRefs,
            ...lastMediaRefs,
          ];
          const directMedia = [
            ...this.extractDirectMediaFromMessage(messageObj),
            ...lastDirectMedia,
          ];
          const finalTextPreview = finalTextRaw.replace(/\s+/g, " ").slice(0, 240);
          console.log(
            `[gateway] openclaw final media parse start `
            + `session=${params.sessionKey} run=${runId || payloadRunId || "unknown"} `
            + `parsedRefs=${parsedText.mediaRefs.length} payloadRefs=${payloadRefs.length} `
            + `directMedia=${directMedia.length} hasMediaMarker=${/^\s*(?:📎\s*)?MEDIA\b/i.test(finalTextRaw)} `
            + `preview=${JSON.stringify(finalTextPreview)}`,
          );
          void this.resolveMediaReferences(payloadRefs, {
            workspaceDir: params.workspaceDir,
            homeDir: params.homeDir,
            extraRoots: params.extraLocalMediaRoots,
          }).then(async (resolvedMedia) => {
            let mergedMedia = this.dedupeMediaItems([...directMedia, ...resolvedMedia]);
            console.log(
              `[gateway] openclaw final media parse resolved `
              + `session=${params.sessionKey} run=${runId || payloadRunId || "unknown"} `
              + `resolvedMedia=${resolvedMedia.length} mergedMedia=${mergedMedia.length}`,
            );
            if (mergedMedia.length === 0 && /^\s*(?:📎\s*)?MEDIA\b/i.test(finalTextRaw)) {
              const looseRefs = this.extractLooseLocalMediaReferences(finalTextRaw, {
                workspaceDir: params.workspaceDir,
                homeDir: params.homeDir,
                extraRoots: params.extraLocalMediaRoots,
              });
              console.warn(
                `[gateway] openclaw final media parse unresolved after primary pass `
                + `session=${params.sessionKey} run=${runId || payloadRunId || "unknown"} `
                + `looseRefs=${looseRefs.length} parsedRefs=${parsedText.mediaRefs.length} `
                + `payloadRefs=${payloadRefs.length}`,
              );
              if (looseRefs.length > 0) {
                const fallbackResolvedMedia = await this.resolveMediaReferences(looseRefs, {
                  workspaceDir: params.workspaceDir,
                  homeDir: params.homeDir,
                  extraRoots: params.extraLocalMediaRoots,
                });
                mergedMedia = this.dedupeMediaItems([...mergedMedia, ...fallbackResolvedMedia]);
                console.log(
                  `[gateway] openclaw final media parse loose fallback `
                  + `session=${params.sessionKey} run=${runId || payloadRunId || "unknown"} `
                  + `fallbackResolvedMedia=${fallbackResolvedMedia.length} mergedMedia=${mergedMedia.length}`,
                );
              }
            }
            if (mergedMedia.length === 0 && !/^\s*(?:📎\s*)?MEDIA\b/i.test(finalTextRaw)) {
              const placeholderFallback = await this.resolveMediaPlaceholderFallback(finalTextRaw, {
                workspaceDir: params.workspaceDir,
                homeDir: params.homeDir,
                extraRoots: params.extraLocalMediaRoots,
                runStartedAtMs,
                allowEmptyMarkerFallback: params.allowEmptyMediaPlaceholderFallback,
              });
              if (placeholderFallback.length > 0) {
                mergedMedia = this.dedupeMediaItems([...mergedMedia, ...placeholderFallback]);
              }
              console.log(
                `[gateway] openclaw final media parse placeholder fallback `
                + `session=${params.sessionKey} run=${runId || payloadRunId || "unknown"} `
                + `placeholderFallback=${placeholderFallback.length} mergedMedia=${mergedMedia.length}`,
              );
            }
            if (mergedMedia.length === 0 && /^\s*(?:📎\s*)?MEDIA\b/i.test(finalTextRaw)) {
              const sessionFile = this.resolveOpenClawSessionFile(params.sessionKey, params.homeDir);
              const sessionRefs = this.extractLatestAssistantMediaRefsFromSession(sessionFile, {
                runStartedAtMs,
                workspaceDir: params.workspaceDir,
                homeDir: params.homeDir,
                extraRoots: params.extraLocalMediaRoots,
              });
              if (sessionRefs.length > 0) {
                const sessionResolvedMedia = await this.resolveMediaReferences(sessionRefs, {
                  workspaceDir: params.workspaceDir,
                  homeDir: params.homeDir,
                  extraRoots: params.extraLocalMediaRoots,
                });
                mergedMedia = this.dedupeMediaItems([...mergedMedia, ...sessionResolvedMedia]);
                console.log(
                  `[gateway] openclaw final media parse session fallback `
                  + `session=${params.sessionKey} run=${runId || payloadRunId || "unknown"} `
                  + `sessionFile=${JSON.stringify(sessionFile)} sessionRefs=${sessionRefs.length} `
                  + `sessionResolvedMedia=${sessionResolvedMedia.length} mergedMedia=${mergedMedia.length}`,
                );
              }
            }
            const fallbackText = (!parsedText.text && mergedMedia.length === 0 && /^\s*(?:📎\s*)?MEDIA\b/i.test(finalTextRaw))
              ? "(openclaw returned MEDIA placeholder without resolvable file)"
              : (parsedText.text || (mergedMedia.length === 0
                ? this.buildEmptyReplyFallback(finalTextRaw, messageObj, payload)
                : ""));
            if (fallbackText === "(openclaw returned MEDIA placeholder without resolvable file)") {
              console.warn(
                `[gateway] openclaw final media parse placeholder failure `
                + `session=${params.sessionKey} run=${runId || payloadRunId || "unknown"} `
                + `parsedRefs=${parsedText.mediaRefs.length} payloadRefs=${payloadRefs.length} `
                + `directMedia=${directMedia.length} mergedMedia=${mergedMedia.length} `
                + `preview=${JSON.stringify(finalTextPreview)}`,
              );
            }
            done({
              text: fallbackText,
              media: mergedMedia,
              audioAsVoice: Boolean(parsedText.audioAsVoice || lastAudioAsVoice),
            });
          }).catch((error) => {
            const msg = error instanceof Error ? error.message : String(error);
            fail(`openclaw media parse failed: ${msg}`);
          });
          return;
        }
        if (state === "error") {
          const errText = toString(payload.errorMessage).trim() || "unknown error";
          fail(`openclaw run failed: ${errText}`);
          return;
        }
        if (state === "aborted") {
          const reason = toString(payload.stopReason).trim() || "aborted";
          fail(`openclaw run aborted: ${reason}`);
        }
      });

      ws.once("error", (error) => {
        fail(`openclaw gateway websocket error: ${error.message}`);
      });
      ws.once("close", (code, reason) => {
        if (closed) {
          return;
        }
        const detail = reason.toString().trim();
        fail(`openclaw gateway closed (${code})${detail ? `: ${detail}` : ""}`);
      });
    });
  }

  private async ensureOpenClawEntry(): Promise<void> {
    if (this.distChecked) {
      return;
    }

    if (!fs.existsSync(this.config.openclawRoot)) {
      throw new Error(`openclaw root not found: ${this.config.openclawRoot}`);
    }
    if (!fs.existsSync(this.openclawEntryPath)) {
      throw new Error(`openclaw entry not found: ${this.openclawEntryPath}`);
    }

    let hasDist = this.distEntryCandidates.some((candidate) => fs.existsSync(candidate));
    if (!hasDist && this.config.autoBuildDist) {
      console.log("[gateway] openclaw dist missing. building dist with `pnpm exec tsdown --no-clean` ...");
      const build = await this.runCommand("pnpm", ["exec", "tsdown", "--no-clean"], {
        cwd: this.config.openclawRoot,
        timeoutMs: 20 * 60 * 1000,
      });
      if (build.code !== 0) {
        throw new Error(
          `failed to build openclaw dist: ${build.stderr.trim() || build.stdout.trim() || "unknown error"}`,
        );
      }
      hasDist = this.distEntryCandidates.some((candidate) => fs.existsSync(candidate));
    }

    if (!hasDist) {
      throw new Error(
        `openclaw dist is missing under ${path.join(this.config.openclawRoot, "dist")}. run "pnpm install && pnpm build:strict-smoke" in openclaw first.`,
      );
    }

    this.distChecked = true;
  }

  private async runCommand(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    },
  ): Promise<CommandRunResult> {
    return await new Promise<CommandRunResult>((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeoutMs = options?.timeoutMs ?? 0;
      let timer: NodeJS.Timeout | undefined;

      const finalize = (result: CommandRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve(result);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finalize({
            code: -1,
            stdout,
            stderr: `${stderr}\ncommand timeout after ${timeoutMs}ms`.trim(),
          });
        }, timeoutMs);
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        finalize({
          code: -1,
          stdout,
          stderr,
          spawnError: error,
        });
      });
      child.once("close", (code) => {
        finalize({
          code: typeof code === "number" ? code : -1,
          stdout,
          stderr,
        });
      });
    });
  }
}

function renderTerminalStream(raw: string): RenderedTerminalOutput {
  const source = raw.replace(/\n\[tmux redraw\]\n/g, "\n");

  const outLines: string[] = [];
  const dynamicFrames: string[] = [];
  let line: string[] = [];
  let cursor = 0;
  let i = 0;

  const pushDynamicFrame = () => {
    const frame = trimRenderedLine(line.join(""));
    if (!frame) {
      return;
    }
    if (dynamicFrames.length > 0 && dynamicFrames[dynamicFrames.length - 1] === frame) {
      return;
    }
    dynamicFrames.push(frame);
  };

  const commitLine = () => {
    const value = trimRenderedLine(line.join(""));
    if (value) {
      outLines.push(value);
    }
    line = [];
    cursor = 0;
  };

  const clearToEndOfLine = () => {
    line.length = cursor;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\x1b") {
      const next = source[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < source.length && !isAnsiCsiFinal(source[j])) {
          j += 1;
        }
        const cmd = source[j];
        if (cmd === "K") {
          clearToEndOfLine();
        }
        i = j < source.length ? j + 1 : source.length;
        continue;
      }

      if (next === "]") {
        let j = i + 2;
        while (j < source.length) {
          if (source[j] === "\x07") {
            j += 1;
            break;
          }
          if (source[j] === "\x1b" && source[j + 1] === "\\") {
            j += 2;
            break;
          }
          j += 1;
        }
        i = j;
        continue;
      }

      i += 1;
      continue;
    }

    if (ch === "\r") {
      pushDynamicFrame();
      cursor = 0;
      i += 1;
      continue;
    }

    if (ch === "\n") {
      commitLine();
      i += 1;
      continue;
    }

    if (ch === "\b") {
      if (cursor > 0) {
        cursor -= 1;
        if (cursor < line.length) {
          line.splice(cursor, 1);
        }
      }
      i += 1;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      i += 1;
      continue;
    }

    if (cursor === line.length) {
      line.push(ch);
    } else {
      line[cursor] = ch;
    }
    cursor += 1;
    i += 1;
  }

  commitLine();

  const text = outLines.join("\n").trim();
  const frames = dynamicFrames.map((item) => trimRenderedLine(item)).filter(Boolean);
  return {
    text,
    dynamicFrames: frames,
  };
}

function loadGatewayConfig(): LoadedGatewayConfig {
  const configPath = path.resolve(process.env.TFCLAW_CONFIG_PATH ?? "config.json");
  const configDir = path.dirname(configPath);
  let fromFile = false;
  let rawConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      const rawText = fs.readFileSync(configPath, "utf8");
      rawConfig = toObject(JSON.parse(rawText));
      fromFile = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse config file (${configPath}): ${msg}`);
    }
  } else {
    console.warn(`[gateway] config file not found: ${configPath}`);
    console.warn("[gateway] fallback to environment variables for compatibility.");
  }

  const rawRelay = toObject(rawConfig.relay);
  const rawNexChatBot = toObject(rawConfig.nexchatbot);
  const rawOpenClawBridge = toObject(rawConfig.openclawBridge);
  const rawChannels = toObject(rawConfig.channels);

  const rawFeishu = toObject(rawChannels.feishu);
  const feishuAppId = toString(rawFeishu.appId, process.env.FEISHU_APP_ID ?? "");
  const feishuAppSecret = toString(rawFeishu.appSecret, process.env.FEISHU_APP_SECRET ?? "");
  const feishuEnabledFallback = feishuAppId.length > 0 && feishuAppSecret.length > 0;
  const hasFeishuEnabled = Object.prototype.hasOwnProperty.call(rawFeishu, "enabled");
  const feishuEnabled = hasFeishuEnabled ? toBoolean(rawFeishu.enabled, feishuEnabledFallback) : feishuEnabledFallback;
  const feishuAllowFromFallback = parseCsv(process.env.FEISHU_ALLOW_FROM);
  const rawFeishuRenderMode = toString(
    rawFeishu.renderMode,
    process.env.TFCLAW_FEISHU_RENDER_MODE ?? "auto",
  ).trim().toLowerCase();
  const feishuRenderMode: FeishuRenderMode = rawFeishuRenderMode === "raw" || rawFeishuRenderMode === "card"
    ? rawFeishuRenderMode
    : "auto";

  const rawTelegram = toObject(rawChannels.telegram);
  const rawWhatsApp = toObject(rawChannels.whatsapp);
  const rawDiscord = toObject(rawChannels.discord);
  const rawMochat = toObject(rawChannels.mochat);
  const rawDingTalk = toObject(rawChannels.dingtalk);
  const rawEmail = toObject(rawChannels.email);
  const rawSlack = toObject(rawChannels.slack);
  const rawQq = toObject(rawChannels.qq);

  const nexChatBotEnabledFallback = toBoolean(process.env.TFCLAW_NEXCHATBOT_ENABLED, false);
  const nexChatBotBaseUrl = toString(rawNexChatBot.baseUrl, process.env.TFCLAW_NEXCHATBOT_BASE_URL ?? "http://127.0.0.1:8094");
  const nexChatBotRunPath = toString(rawNexChatBot.runPath, process.env.TFCLAW_NEXCHATBOT_RUN_PATH ?? "/v1/main-agent/feishu-bridge");
  const nexChatBotApiKey = toString(rawNexChatBot.apiKey, process.env.TFCLAW_NEXCHATBOT_API_KEY ?? "");
  const nexChatBotTimeoutMs = Math.max(
    1000,
    Math.min(10 * 60 * 1000, toNumber(rawNexChatBot.timeoutMs, toNumber(process.env.TFCLAW_NEXCHATBOT_TIMEOUT_MS, 90_000))),
  );

  const openclawRootFallback = resolvePathFromBase(
    toString(rawOpenClawBridge.openclawRoot, process.env.TFCLAW_OPENCLAW_ROOT ?? path.join("..", "openclaw")),
    configDir,
  );
  const openclawBridgeEnabledFallback = toBoolean(process.env.TFCLAW_OPENCLAW_ENABLED, false);
  const openclawSharedSkillsDirFallback = resolvePathFromBase(
    toString(
      rawOpenClawBridge.sharedSkillsDir,
      process.env.TFCLAW_OPENCLAW_SHARED_SKILLS_DIR ?? path.join(openclawRootFallback, "skills"),
    ),
    configDir,
  );
  const openclawUserHomeRootFallback = resolvePathFromBase(
    toString(
      rawOpenClawBridge.userHomeRoot,
      process.env.TFCLAW_OPENCLAW_USER_HOME_ROOT ?? ".home",
    ),
    configDir,
  );
  const openclawStateDir = resolvePathFromBase(
    toString(
      rawOpenClawBridge.stateDir,
      process.env.TFCLAW_OPENCLAW_STATE_DIR ?? path.join(".runtime", "openclaw_bridge"),
    ),
    configDir,
  );
  const openclawSharedEnvPath = resolvePathFromBase(
    toString(
      rawOpenClawBridge.sharedEnvPath,
      process.env.TFCLAW_OPENCLAW_SHARED_ENV_PATH ?? path.join(openclawStateDir, ".env"),
    ),
    configDir,
  );
  const openclawConfigTemplatePath = resolvePathFromBase(
    toString(
      rawOpenClawBridge.configTemplatePath,
      process.env.TFCLAW_OPENCLAW_CONFIG_TEMPLATE_PATH ?? "",
    ),
    configDir,
    { allowEmpty: true },
  );
  const openclawGatewayPortBase = Math.max(
    1025,
    Math.min(65535, toNumber(rawOpenClawBridge.gatewayPortBase, toNumber(process.env.TFCLAW_OPENCLAW_GATEWAY_PORT_BASE, 19000))),
  );
  const openclawGatewayPortMax = Math.max(
    openclawGatewayPortBase,
    Math.min(65535, toNumber(rawOpenClawBridge.gatewayPortMax, toNumber(process.env.TFCLAW_OPENCLAW_GATEWAY_PORT_MAX, 19999))),
  );
  const openclawStartupTimeoutMs = Math.max(
    1000,
    Math.min(10 * 60 * 1000, toNumber(rawOpenClawBridge.startupTimeoutMs, toNumber(process.env.TFCLAW_OPENCLAW_STARTUP_TIMEOUT_MS, 45_000))),
  );
  const openclawRequestTimeoutMs = Math.max(
    1000,
    Math.min(30 * 60 * 1000, toNumber(rawOpenClawBridge.requestTimeoutMs, toNumber(process.env.TFCLAW_OPENCLAW_REQUEST_TIMEOUT_MS, 600_000))),
  );
  const openclawFeishuEncryptKey = toString(
    rawOpenClawBridge.feishuEncryptKey,
    toString(
      process.env.TFCLAW_OPENCLAW_FEISHU_ENCRYPT_KEY,
      toString(rawFeishu.encryptKey, toString(process.env.FEISHU_ENCRYPT_KEY, "")),
    ),
  );

  const relayToken = toString(rawRelay.token, process.env.TFCLAW_TOKEN ?? "");
  if (!relayToken) {
    throw new Error("missing relay token. set relay.token in config.json or TFCLAW_TOKEN in env.");
  }

  const config: GatewayConfig = {
    relay: {
      token: relayToken,
      url: toString(rawRelay.url, process.env.TFCLAW_RELAY_URL ?? "ws://127.0.0.1:8787"),
    },
    nexchatbot: {
      enabled: toBoolean(rawNexChatBot.enabled, nexChatBotEnabledFallback),
      baseUrl: nexChatBotBaseUrl,
      runPath: nexChatBotRunPath,
      apiKey: nexChatBotApiKey,
      timeoutMs: nexChatBotTimeoutMs,
    },
    openclawBridge: {
      enabled: toBoolean(rawOpenClawBridge.enabled, openclawBridgeEnabledFallback),
      openclawRoot: openclawRootFallback,
      stateDir: openclawStateDir,
      sharedEnvPath: openclawSharedEnvPath,
      sharedSkillsDir: openclawSharedSkillsDirFallback,
      userHomeRoot: openclawUserHomeRootFallback,
      userPrefix: toString(rawOpenClawBridge.userPrefix, process.env.TFCLAW_OPENCLAW_USER_PREFIX ?? "tfoc_"),
      tmuxSessionPrefix: toString(
        rawOpenClawBridge.tmuxSessionPrefix,
        process.env.TFCLAW_OPENCLAW_TMUX_SESSION_PREFIX ?? "tfoc-",
      ),
      gatewayHost: toString(rawOpenClawBridge.gatewayHost, process.env.TFCLAW_OPENCLAW_GATEWAY_HOST ?? "127.0.0.1"),
      gatewayPortBase: openclawGatewayPortBase,
      gatewayPortMax: openclawGatewayPortMax,
      startupTimeoutMs: openclawStartupTimeoutMs,
      requestTimeoutMs: openclawRequestTimeoutMs,
      sessionKey: toString(rawOpenClawBridge.sessionKey, process.env.TFCLAW_OPENCLAW_SESSION_KEY ?? "main"),
      nodePath: toString(rawOpenClawBridge.nodePath, process.env.TFCLAW_OPENCLAW_NODE_PATH ?? process.execPath),
      configTemplatePath: openclawConfigTemplatePath,
      autoBuildDist: toBoolean(
        rawOpenClawBridge.autoBuildDist,
        toBoolean(process.env.TFCLAW_OPENCLAW_AUTO_BUILD_DIST, false),
      ),
      allowAutoCreateUser: toBoolean(
        rawOpenClawBridge.allowAutoCreateUser,
        toBoolean(process.env.TFCLAW_OPENCLAW_ALLOW_AUTO_CREATE_USER, true),
      ),
      feishuAppId: toString(rawOpenClawBridge.feishuAppId, feishuAppId),
      feishuAppSecret: toString(rawOpenClawBridge.feishuAppSecret, feishuAppSecret),
      feishuVerificationToken: toString(
        rawOpenClawBridge.feishuVerificationToken,
        toString(rawFeishu.verificationToken, ""),
      ),
      feishuEncryptKey: openclawFeishuEncryptKey,
      feishuWebhookPortOffset: Math.max(
        100,
        Math.min(
          50000,
          toNumber(
            rawOpenClawBridge.feishuWebhookPortOffset,
            toNumber(process.env.TFCLAW_OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET, 20000),
          ),
        ),
      ),
    },
    channels: {
      whatsapp: {
        enabled: toBoolean(rawWhatsApp.enabled, false),
        allowFrom: toStringArray(rawWhatsApp.allowFrom),
        bridgeUrl: toString(rawWhatsApp.bridgeUrl, "ws://localhost:3001"),
        bridgeToken: toString(rawWhatsApp.bridgeToken, ""),
      },
      telegram: {
        enabled: toBoolean(rawTelegram.enabled, false),
        allowFrom: toStringArray(rawTelegram.allowFrom),
        token: toString(rawTelegram.token, ""),
        proxy: toString(rawTelegram.proxy, ""),
        replyToMessage: toBoolean(rawTelegram.replyToMessage, false),
      },
      discord: {
        enabled: toBoolean(rawDiscord.enabled, false),
        allowFrom: toStringArray(rawDiscord.allowFrom),
        token: toString(rawDiscord.token, ""),
        gatewayUrl: toString(rawDiscord.gatewayUrl, "wss://gateway.discord.gg/?v=10&encoding=json"),
        intents: toNumber(rawDiscord.intents, 37377),
      },
      feishu: {
        enabled: feishuEnabled,
        allowFrom: toStringArray(rawFeishu.allowFrom, feishuAllowFromFallback),
        appId: feishuAppId,
        appSecret: feishuAppSecret,
        encryptKey: toString(rawFeishu.encryptKey, ""),
        verificationToken: toString(rawFeishu.verificationToken, ""),
        disableProxy: toBoolean(rawFeishu.disableProxy, toBoolean(process.env.TFCLAW_FEISHU_DISABLE_PROXY, true)),
        noProxyHosts: toStringArray(rawFeishu.noProxyHosts, [
          "open.feishu.cn",
          ".feishu.cn",
          "open.larksuite.com",
          ".larksuite.com",
        ]),
        renderMode: feishuRenderMode,
      },
      mochat: {
        enabled: toBoolean(rawMochat.enabled, false),
        allowFrom: toStringArray(rawMochat.allowFrom),
        baseUrl: toString(rawMochat.baseUrl, "https://mochat.io"),
        clawToken: toString(rawMochat.clawToken, ""),
      },
      dingtalk: {
        enabled: toBoolean(rawDingTalk.enabled, false),
        allowFrom: toStringArray(rawDingTalk.allowFrom),
        clientId: toString(rawDingTalk.clientId, ""),
        clientSecret: toString(rawDingTalk.clientSecret, ""),
      },
      email: {
        enabled: toBoolean(rawEmail.enabled, false),
        allowFrom: toStringArray(rawEmail.allowFrom),
        imapHost: toString(rawEmail.imapHost, ""),
        imapUsername: toString(rawEmail.imapUsername, ""),
        imapPassword: toString(rawEmail.imapPassword, ""),
        smtpHost: toString(rawEmail.smtpHost, ""),
        smtpUsername: toString(rawEmail.smtpUsername, ""),
        smtpPassword: toString(rawEmail.smtpPassword, ""),
      },
      slack: {
        enabled: toBoolean(rawSlack.enabled, false),
        allowFrom: toStringArray(rawSlack.allowFrom),
        botToken: toString(rawSlack.botToken, ""),
        appToken: toString(rawSlack.appToken, ""),
        groupPolicy: toString(rawSlack.groupPolicy, "mention"),
      },
      qq: {
        enabled: toBoolean(rawQq.enabled, false),
        allowFrom: toStringArray(rawQq.allowFrom),
        appId: toString(rawQq.appId, ""),
        secret: toString(rawQq.secret, ""),
      },
    },
  };

  return {
    config,
    configPath,
    fromFile,
  };
}

// SECTION: relay bridge
class RelayBridge {
  private ws: WebSocket | undefined;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingCaptures = new Map<string, PendingCapture>();
  private pendingCaptureSourceLists = new Map<string, PendingCaptureSourceList>();
  private pendingCommandResults = new Map<string, PendingCommandResult>();
  private earlyCommandOutcomes = new Map<string, { ok: boolean; value: string; at: number }>();
  private earlyCommandProgress = new Map<string, EarlyCommandProgress[]>();
  private readonly earlyCommandOutcomeTtlMs = 60_000;

  readonly cache: RelayCache = {
    terminals: new Map<string, TerminalSummary>(),
    snapshots: new Map<string, TerminalSnapshot>(),
  };

  constructor(
    private readonly relayUrl: string,
    private readonly relayToken: string,
    private readonly clientType: "mobile" | "feishu" | "web" = "web",
  ) {}

  connect(): void {
    const url = new URL(this.relayUrl);
    url.searchParams.set("role", "client");
    url.searchParams.set("token", this.relayToken);

    this.ws = new WebSocket(url.toString());

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.send({
        type: "client.hello",
        payload: {
          clientType: this.clientType,
        },
      });
      console.log(`[gateway] relay connected: ${url}`);
    });

    this.ws.on("message", (raw) => {
      this.handleRelayMessage(raw.toString());
    });

    this.ws.on("close", () => {
      if (this.closed) {
        return;
      }
      this.rejectAllPending(new Error("relay disconnected"));
      this.reconnectAttempts += 1;
      const retryDelay = Math.min(10000, this.reconnectAttempts * 500);
      console.warn(`[gateway] relay disconnected. reconnect in ${retryDelay}ms`);
      setTimeout(() => this.connect(), retryDelay);
    });

    this.ws.on("error", (err) => {
      console.error("[gateway] relay error:", err.message);
    });
  }

  close(): void {
    this.closed = true;
    this.rejectAllPending(new Error("relay closed"));
    this.ws?.close();
  }

  send(message: RelayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(jsonStringify(message));
    }
  }

  command(payload: ClientCommand["payload"]): string {
    const requestId = randomId();
    this.send({
      type: "client.command",
      requestId,
      payload,
    });
    return requestId;
  }

  waitForCapture(requestId: string, timeoutMs = 20000): Promise<ScreenCapture> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCaptures.delete(requestId);
        reject(new Error("capture timeout"));
      }, timeoutMs);

      this.pendingCaptures.set(requestId, {
        resolve,
        reject,
        timer,
      });
    });
  }

  waitForCaptureSources(requestId: string, timeoutMs = 15000): Promise<CaptureSource[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCaptureSourceLists.delete(requestId);
        reject(new Error("capture source list timeout"));
      }, timeoutMs);

      this.pendingCaptureSourceLists.set(requestId, {
        resolve,
        reject,
        timer,
      });
    });
  }

  waitForCommandResult(
    requestId: string,
    timeoutMs = COMMAND_RESULT_TIMEOUT_MS,
    onProgress?: (output: string, source?: string) => void | Promise<void>,
  ): Promise<string> {
    this.pruneEarlyCommandOutcomes();
    this.pruneEarlyCommandProgress();
    const early = this.earlyCommandOutcomes.get(requestId);
    if (early) {
      this.earlyCommandOutcomes.delete(requestId);
      this.earlyCommandProgress.delete(requestId);
      if (early.ok) {
        return Promise.resolve(early.value);
      }
      return Promise.reject(new Error(early.value));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommandResults.delete(requestId);
        reject(new Error("command timeout"));
      }, timeoutMs);

      this.pendingCommandResults.set(requestId, {
        resolve,
        reject,
        timer,
        onProgress,
      });

      const earlyProgressItems = this.earlyCommandProgress.get(requestId);
      if (earlyProgressItems?.length && onProgress) {
        for (const item of earlyProgressItems) {
          void Promise
            .resolve(onProgress(item.output, item.progressSource))
            .catch((error) => console.warn(`[gateway] progress callback failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      this.earlyCommandProgress.delete(requestId);
    });
  }

  private handleRelayMessage(raw: string): void {
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      return;
    }

    if (parsed.type === "relay.state") {
      this.cache.terminals.clear();
      for (const terminal of parsed.payload.terminals) {
        this.cache.terminals.set(terminal.terminalId, terminal);
      }

      this.cache.snapshots.clear();
      for (const snapshot of parsed.payload.snapshots) {
        this.cache.snapshots.set(snapshot.terminalId, snapshot);
      }
      return;
    }

    if (parsed.type === "agent.terminal_output") {
      const existing = this.cache.snapshots.get(parsed.payload.terminalId);
      const merged = `${existing?.output ?? ""}${parsed.payload.chunk}`;
      this.cache.snapshots.set(parsed.payload.terminalId, {
        terminalId: parsed.payload.terminalId,
        output: merged.length > 12000 ? merged.slice(-12000) : merged,
        updatedAt: parsed.payload.at,
      });
      return;
    }

    if (parsed.type === "agent.capture_sources") {
      if (parsed.payload.requestId) {
        const pending = this.pendingCaptureSourceLists.get(parsed.payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCaptureSourceLists.delete(parsed.payload.requestId);
          pending.resolve(parsed.payload.sources);
        }
      }
      return;
    }

    if (parsed.type === "agent.screen_capture") {
      if (parsed.payload.requestId) {
        const pending = this.pendingCaptures.get(parsed.payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCaptures.delete(parsed.payload.requestId);
          pending.resolve(parsed.payload);
        }
      }
      return;
    }

    if (parsed.type === "agent.command_result") {
      if (parsed.payload.requestId) {
        const isProgress = Boolean(parsed.payload.progress);
        const pending = this.pendingCommandResults.get(parsed.payload.requestId);
        if (isProgress) {
          if (pending?.onProgress) {
            void Promise
              .resolve(pending.onProgress(parsed.payload.output, parsed.payload.progressSource))
              .catch((error) => console.warn(`[gateway] progress callback failed: ${error instanceof Error ? error.message : String(error)}`));
          } else if (!pending) {
            this.saveEarlyCommandProgress(parsed.payload.requestId, parsed.payload.output, parsed.payload.progressSource);
          }
        } else {
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCommandResults.delete(parsed.payload.requestId);
            pending.resolve(parsed.payload.output);
          } else {
            this.saveEarlyCommandOutcome(parsed.payload.requestId, true, parsed.payload.output);
          }
          this.earlyCommandProgress.delete(parsed.payload.requestId);
        }
      }
      return;
    }

    if (parsed.type === "agent.error" && parsed.payload.requestId) {
      const pendingCapture = this.pendingCaptures.get(parsed.payload.requestId);
      if (pendingCapture) {
        clearTimeout(pendingCapture.timer);
        this.pendingCaptures.delete(parsed.payload.requestId);
        pendingCapture.reject(new Error(`${parsed.payload.code}: ${parsed.payload.message}`));
        return;
      }

      const pendingSources = this.pendingCaptureSourceLists.get(parsed.payload.requestId);
      if (pendingSources) {
        clearTimeout(pendingSources.timer);
        this.pendingCaptureSourceLists.delete(parsed.payload.requestId);
        pendingSources.reject(new Error(`${parsed.payload.code}: ${parsed.payload.message}`));
        return;
      }

      const pendingCommand = this.pendingCommandResults.get(parsed.payload.requestId);
      if (pendingCommand) {
        clearTimeout(pendingCommand.timer);
        this.pendingCommandResults.delete(parsed.payload.requestId);
        pendingCommand.reject(new Error(`${parsed.payload.code}: ${parsed.payload.message}`));
        return;
      }

      this.earlyCommandProgress.delete(parsed.payload.requestId);
      this.saveEarlyCommandOutcome(parsed.payload.requestId, false, `${parsed.payload.code}: ${parsed.payload.message}`);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingCaptures.entries()) {
      clearTimeout(pending.timer);
      this.pendingCaptures.delete(requestId);
      pending.reject(error);
    }

    for (const [requestId, pending] of this.pendingCaptureSourceLists.entries()) {
      clearTimeout(pending.timer);
      this.pendingCaptureSourceLists.delete(requestId);
      pending.reject(error);
    }

    for (const [requestId, pending] of this.pendingCommandResults.entries()) {
      clearTimeout(pending.timer);
      this.pendingCommandResults.delete(requestId);
      pending.reject(error);
    }

    this.earlyCommandOutcomes.clear();
    this.earlyCommandProgress.clear();
  }

  private saveEarlyCommandOutcome(requestId: string, ok: boolean, value: string): void {
    if (!requestId) {
      return;
    }
    this.pruneEarlyCommandOutcomes();
    this.earlyCommandOutcomes.set(requestId, {
      ok,
      value,
      at: Date.now(),
    });
  }

  private saveEarlyCommandProgress(requestId: string, output: string, progressSource?: string): void {
    if (!requestId) {
      return;
    }
    this.pruneEarlyCommandProgress();
    const list = this.earlyCommandProgress.get(requestId) ?? [];
    list.push({
      output,
      progressSource,
      at: Date.now(),
    });
    if (list.length > 128) {
      list.splice(0, list.length - 128);
    }
    this.earlyCommandProgress.set(requestId, list);
  }

  private pruneEarlyCommandOutcomes(): void {
    const now = Date.now();
    for (const [requestId, outcome] of this.earlyCommandOutcomes.entries()) {
      if (now - outcome.at > this.earlyCommandOutcomeTtlMs) {
        this.earlyCommandOutcomes.delete(requestId);
      }
    }
  }

  private pruneEarlyCommandProgress(): void {
    const now = Date.now();
    for (const [requestId, list] of this.earlyCommandProgress.entries()) {
      const filtered = list.filter((item) => now - item.at <= this.earlyCommandOutcomeTtlMs);
      if (filtered.length === 0) {
        this.earlyCommandProgress.delete(requestId);
        continue;
      }
      if (filtered.length !== list.length) {
        this.earlyCommandProgress.set(requestId, filtered);
      }
    }
  }
}
class TfclawAccessManager {
  private readonly stateFilePath: string;
  private readonly superRootConfigPath: string;
  private readonly groupWorkspaceRoot: string;
  private readonly legacyGroupWorkspaceRoot: string;
  private lock: Promise<void> = Promise.resolve();

  constructor(stateDir: string, userHomeRoot: string) {
    const resolvedStateDir = path.resolve(stateDir);
    const resolvedUserHomeRoot = path.resolve(userHomeRoot);
    fs.mkdirSync(resolvedStateDir, { recursive: true });
    fs.mkdirSync(resolvedUserHomeRoot, { recursive: true });
    this.stateFilePath = path.join(resolvedStateDir, "access-control.json");
    this.superRootConfigPath = path.join(resolvedStateDir, "super-root.local.json");
    this.legacyGroupWorkspaceRoot = path.join(resolvedStateDir, "group_workspaces");
    this.groupWorkspaceRoot = path.join(resolvedUserHomeRoot, "_groups");
    fs.mkdirSync(this.groupWorkspaceRoot, { recursive: true });
    try {
      fs.chmodSync(resolvedUserHomeRoot, 0o711);
    } catch {
      // Ignore mode errors and continue.
    }
    try {
      fs.chmodSync(this.groupWorkspaceRoot, 0o711);
    } catch {
      // Ignore mode errors and continue.
    }
  }

  private defaultState(): TfclawAccessStateFile {
    return {
      version: 1,
      admins: [],
      groups: {},
      aliases: {},
      userProfiles: {},
    };
  }

  private normalizeUserKey(value: string): string {
    return value.trim();
  }

  private normalizeGroupName(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
  }

  private normalizeAlias(value: string): string {
    return value.trim().toLowerCase();
  }

  private normalizeDisplayName(value: string): string {
    return value.trim().replace(/\s+/g, " ");
  }

  private isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private resolveDefaultGroupWorkspaceDir(groupName: string): string {
    return path.join(this.groupWorkspaceRoot, groupName, "workspace");
  }

  private migrateLegacyGroupWorkspaceDir(groupName: string, workspaceDir: string): string {
    const resolvedWorkspace = path.resolve(workspaceDir);
    if (!this.isPathInsideRoot(resolvedWorkspace, this.legacyGroupWorkspaceRoot)) {
      return resolvedWorkspace;
    }
    const relative = path.relative(this.legacyGroupWorkspaceRoot, resolvedWorkspace);
    const fallbackRelative = path.join(groupName, "workspace");
    const targetRelative = relative.trim() ? relative : fallbackRelative;
    const targetWorkspace = path.resolve(path.join(this.groupWorkspaceRoot, targetRelative));
    if (targetWorkspace === resolvedWorkspace) {
      return resolvedWorkspace;
    }
    if (fs.existsSync(resolvedWorkspace) && !fs.existsSync(targetWorkspace)) {
      fs.mkdirSync(path.dirname(targetWorkspace), { recursive: true });
      try {
        fs.renameSync(resolvedWorkspace, targetWorkspace);
      } catch {
        fs.cpSync(resolvedWorkspace, targetWorkspace, { recursive: true });
      }
    }
    fs.mkdirSync(targetWorkspace, { recursive: true });
    return targetWorkspace;
  }

  private looksLikeFeishuUserIdentifier(value: string): boolean {
    return /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(value.trim());
  }

  private looksLikeLinuxUser(value: string): boolean {
    return /^tfoc_[a-f0-9]+$/i.test(value.trim());
  }

  private isDisplayNameAliasCandidate(value: string): boolean {
    const normalized = this.normalizeDisplayName(value);
    if (!normalized) {
      return false;
    }
    if (this.looksLikeFeishuUserIdentifier(normalized) || this.looksLikeLinuxUser(normalized)) {
      return false;
    }
    // Prefer true human-readable names as fallback display labels.
    if (/\p{Script=Han}/u.test(normalized)) {
      return true;
    }
    if (/[^\x00-\x7F]/.test(normalized)) {
      return true;
    }
    if (/\s/.test(normalized) && /[A-Za-z]/.test(normalized)) {
      return true;
    }
    // Allow simple English names like "fang", while still excluding opaque ids.
    if (/^[A-Za-z][A-Za-z'.-]{1,31}$/.test(normalized)) {
      return true;
    }
    return false;
  }

  private guessDisplayNameFromAliases(state: TfclawAccessStateFile, userKey: string): string | undefined {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    if (!normalizedUserKey) {
      return undefined;
    }
    let best: string | undefined;
    for (const [alias, mappedUserKey] of Object.entries(state.aliases)) {
      if (this.normalizeUserKey(mappedUserKey) !== normalizedUserKey) {
        continue;
      }
      if (!this.isDisplayNameAliasCandidate(alias)) {
        continue;
      }
      const candidate = this.normalizeDisplayName(alias);
      if (!candidate) {
        continue;
      }
      if (!best || candidate.length < best.length) {
        best = candidate;
      }
    }
    return best;
  }

  private roleOf(state: TfclawAccessStateFile, userKey: string): TfclawUserRole {
    const normalized = this.normalizeUserKey(userKey);
    if (!normalized) {
      return "user";
    }
    if (state.superRootUserKey === normalized) {
      return "super_root";
    }
    if (state.admins.includes(normalized)) {
      return "admin";
    }
    return "user";
  }

  private ensureAbsoluteWorkspacePath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw new Error("workspace path is required");
    }
    const resolved = path.resolve(trimmed);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release: (() => void) | undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  private async loadState(): Promise<TfclawAccessStateFile> {
    if (!fs.existsSync(this.stateFilePath)) {
      return this.defaultState();
    }
    try {
      const parsed = toObject(JSON.parse(fs.readFileSync(this.stateFilePath, "utf8")));
      const admins = Array.isArray(parsed.admins)
        ? Array.from(new Set(parsed.admins.map((item) => this.normalizeUserKey(toString(item))).filter(Boolean)))
        : [];
      const aliasesObj = toObject(parsed.aliases);
      const aliases: Record<string, string> = {};
      for (const [rawAlias, rawUserKey] of Object.entries(aliasesObj)) {
        const alias = this.normalizeAlias(rawAlias);
        const userKey = this.normalizeUserKey(toString(rawUserKey));
        if (!alias || !userKey) {
          continue;
        }
        aliases[alias] = userKey;
      }
      const groupsObj = toObject(parsed.groups);
      const groups: Record<string, TfclawAccessGroup> = {};
      for (const [rawKey, rawValue] of Object.entries(groupsObj)) {
        const key = this.normalizeGroupName(rawKey);
        if (!key) {
          continue;
        }
        const value = toObject(rawValue);
        const members = Array.isArray(value.members)
          ? Array.from(new Set(value.members.map((item) => this.normalizeUserKey(toString(item))).filter(Boolean)))
          : [];
        const displayName = toString(value.displayName, key).trim() || key;
        const workspaceDir = this.migrateLegacyGroupWorkspaceDir(
          key,
          this.ensureAbsoluteWorkspacePath(
            toString(value.workspaceDir, this.resolveDefaultGroupWorkspaceDir(key)),
          ),
        );
        groups[key] = {
          name: key,
          displayName,
          scopeUserKey: toString(value.scopeUserKey, `group:${key}`).trim() || `group:${key}`,
          workspaceDir,
          members,
          createdAt: toString(value.createdAt, new Date().toISOString()),
          updatedAt: toString(value.updatedAt, new Date().toISOString()),
        };
      }
      const userProfilesObj = toObject(parsed.userProfiles);
      const userProfiles: Record<string, TfclawUserProfile> = {};
      for (const [rawUserKey, rawProfile] of Object.entries(userProfilesObj)) {
        const userKey = this.normalizeUserKey(rawUserKey);
        if (!userKey) {
          continue;
        }
        const profile = toObject(rawProfile);
        const displayName = this.normalizeDisplayName(toString(profile.displayName, toString(profile.name)));
        if (!displayName) {
          continue;
        }
        userProfiles[userKey] = {
          displayName,
          updatedAt: toString(profile.updatedAt, new Date().toISOString()),
        };
      }
      const state: TfclawAccessStateFile = {
        version: 1,
        superRootUserKey: this.normalizeUserKey(toString(parsed.superRootUserKey)),
        admins,
        groups,
        aliases,
        userProfiles,
      };
      if (state.superRootUserKey && state.admins.includes(state.superRootUserKey)) {
        state.admins = state.admins.filter((item) => item !== state.superRootUserKey);
      }
      return state;
    } catch {
      return this.defaultState();
    }
  }

  private async saveState(state: TfclawAccessStateFile): Promise<void> {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.writeFileSync(this.stateFilePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async getRole(userKey: string): Promise<TfclawUserRole> {
    const state = await this.loadState();
    return this.roleOf(state, userKey);
  }

  async getSuperRootUserKey(): Promise<string | undefined> {
    const state = await this.loadState();
    return state.superRootUserKey;
  }

  readConfiguredSuperRootIdentifier(): string | undefined {
    if (!fs.existsSync(this.superRootConfigPath)) {
      return undefined;
    }
    try {
      const parsed = toObject(JSON.parse(fs.readFileSync(this.superRootConfigPath, "utf8")));
      const configured = toString(parsed.superRoot, toString(parsed.super_root, toString(parsed.user))).trim();
      return configured || undefined;
    } catch {
      return undefined;
    }
  }

  async setSuperRootFromConfig(targetUserKey: string): Promise<void> {
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      return;
    }
    await this.withLock(async () => {
      const state = await this.loadState();
      state.superRootUserKey = target;
      state.admins = state.admins.filter((item) => item !== target);
      await this.saveState(state);
    });
  }

  async registerUserAliases(userKey: string, aliases: string[]): Promise<void> {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    if (!normalizedUserKey) {
      return;
    }
    const normalizedAliases = Array.from(
      new Set(
        aliases
          .map((item) => this.normalizeAlias(item))
          .filter((item) => item.length > 0),
      ),
    );
    if (normalizedAliases.length === 0) {
      return;
    }
    await this.withLock(async () => {
      const state = await this.loadState();
      for (const alias of normalizedAliases) {
        state.aliases[alias] = normalizedUserKey;
      }
      await this.saveState(state);
    });
  }

  async registerUserDisplayName(userKey: string, displayName: string): Promise<void> {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    const normalizedDisplayName = this.normalizeDisplayName(displayName);
    if (!normalizedUserKey || !normalizedDisplayName) {
      return;
    }
    await this.withLock(async () => {
      const state = await this.loadState();
      const existing = state.userProfiles[normalizedUserKey];
      if (existing?.displayName === normalizedDisplayName) {
        return;
      }
      state.userProfiles[normalizedUserKey] = {
        displayName: normalizedDisplayName,
        updatedAt: new Date().toISOString(),
      };
      await this.saveState(state);
    });
  }

  async getUserDisplayName(userKey: string): Promise<string | undefined> {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    if (!normalizedUserKey) {
      return undefined;
    }
    const state = await this.loadState();
    return state.userProfiles[normalizedUserKey]?.displayName || this.guessDisplayNameFromAliases(state, normalizedUserKey);
  }

  async getUserDisplayNames(userKeys: string[]): Promise<Map<string, string>> {
    const state = await this.loadState();
    const output = new Map<string, string>();
    for (const rawUserKey of userKeys) {
      const userKey = this.normalizeUserKey(rawUserKey);
      if (!userKey) {
        continue;
      }
      const displayName = state.userProfiles[userKey]?.displayName || this.guessDisplayNameFromAliases(state, userKey);
      if (!displayName) {
        continue;
      }
      output.set(userKey, displayName);
    }
    return output;
  }

  async resolveUserAlias(input: string): Promise<string | undefined> {
    const alias = this.normalizeAlias(input);
    if (!alias) {
      return undefined;
    }
    const state = await this.loadState();
    return state.aliases[alias];
  }

  async setSuperRoot(requesterUserKey: string, targetUserKey: string): Promise<{ previous?: string; current: string }> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      throw new Error("target user is required");
    }
    return await this.withLock(async () => {
      const state = await this.loadState();
      if (state.superRootUserKey && state.superRootUserKey !== requester) {
        throw new Error("only current super_root can change super_root");
      }
      const previous = state.superRootUserKey;
      state.superRootUserKey = target;
      state.admins = state.admins.filter((item) => item !== target);
      await this.saveState(state);
      return { previous, current: target };
    });
  }

  async setAdmin(requesterUserKey: string, targetUserKey: string, enabled: boolean): Promise<void> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      throw new Error("target user is required");
    }
    return await this.withLock(async () => {
      const state = await this.loadState();
      if (state.superRootUserKey !== requester) {
        throw new Error("only super_root can manage admins");
      }
      if (target === state.superRootUserKey) {
        return;
      }
      if (enabled) {
        if (!state.admins.includes(target)) {
          state.admins.push(target);
        }
      } else {
        state.admins = state.admins.filter((item) => item !== target);
      }
      await this.saveState(state);
    });
  }

  async createGroup(
    requesterUserKey: string,
    displayName: string,
    workspacePath?: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const normalizedName = this.normalizeGroupName(displayName);
    if (!normalizedName) {
      throw new Error("group name is required");
    }
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can create groups");
      }
      if (state.groups[normalizedName]) {
        throw new Error(`group already exists: ${normalizedName}`);
      }
      const workspaceDir = this.ensureAbsoluteWorkspacePath(
        workspacePath?.trim() || this.resolveDefaultGroupWorkspaceDir(normalizedName),
      );
      const now = new Date().toISOString();
      const group: TfclawAccessGroup = {
        name: normalizedName,
        displayName: displayName.trim() || normalizedName,
        scopeUserKey: `group:${normalizedName}`,
        workspaceDir,
        members: [requester],
        createdAt: now,
        updatedAt: now,
      };
      state.groups[normalizedName] = group;
      await this.saveState(state);
      return group;
    });
  }

  async setGroupWorkspace(
    requesterUserKey: string,
    groupName: string,
    workspacePath: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const normalizedName = this.normalizeGroupName(groupName);
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can set group workspace");
      }
      const group = state.groups[normalizedName];
      if (!group) {
        throw new Error(`group not found: ${normalizedName}`);
      }
      group.workspaceDir = this.ensureAbsoluteWorkspacePath(workspacePath);
      group.updatedAt = new Date().toISOString();
      await this.saveState(state);
      return group;
    });
  }

  async addGroupMember(
    requesterUserKey: string,
    groupName: string,
    targetUserKey: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      throw new Error("target user is required");
    }
    const normalizedName = this.normalizeGroupName(groupName);
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can add group members");
      }
      const group = state.groups[normalizedName];
      if (!group) {
        throw new Error(`group not found: ${normalizedName}`);
      }
      if (!group.members.includes(target)) {
        group.members.push(target);
      }
      group.updatedAt = new Date().toISOString();
      await this.saveState(state);
      return group;
    });
  }

  async removeGroupMember(
    requesterUserKey: string,
    groupName: string,
    targetUserKey: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    const normalizedName = this.normalizeGroupName(groupName);
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can remove group members");
      }
      const group = state.groups[normalizedName];
      if (!group) {
        throw new Error(`group not found: ${normalizedName}`);
      }
      group.members = group.members.filter((item) => item !== target);
      group.updatedAt = new Date().toISOString();
      await this.saveState(state);
      return group;
    });
  }

  async getGroup(groupName: string): Promise<TfclawAccessGroup | undefined> {
    const state = await this.loadState();
    const key = this.normalizeGroupName(groupName);
    return key ? state.groups[key] : undefined;
  }

  async getGroupForMember(groupName: string, userKey: string): Promise<TfclawAccessGroup | undefined> {
    const group = await this.getGroup(groupName);
    if (!group) {
      return undefined;
    }
    const normalizedUser = this.normalizeUserKey(userKey);
    if (!group.members.includes(normalizedUser)) {
      return undefined;
    }
    return group;
  }

  async listGroups(): Promise<TfclawAccessGroup[]> {
    const state = await this.loadState();
    return Object.values(state.groups).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listGroupsForUser(userKey: string): Promise<TfclawAccessGroup[]> {
    const normalized = this.normalizeUserKey(userKey);
    const state = await this.loadState();
    return Object.values(state.groups)
      .filter((group) => group.members.includes(normalized))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listUsersWithRoles(extraUserKeys: string[]): Promise<Array<{ userKey: string; role: TfclawUserRole }>> {
    const state = await this.loadState();
    const keys = new Set<string>();
    for (const item of extraUserKeys) {
      const key = this.normalizeUserKey(item);
      if (key) {
        keys.add(key);
      }
    }
    if (state.superRootUserKey) {
      keys.add(state.superRootUserKey);
    }
    for (const admin of state.admins) {
      keys.add(admin);
    }
    for (const group of Object.values(state.groups)) {
      for (const member of group.members) {
        keys.add(member);
      }
    }
    return Array.from(keys)
      .sort((a, b) => a.localeCompare(b))
      .map((userKey) => ({
        userKey,
        role: this.roleOf(state, userKey),
      }));
  }
}

// SECTION: router
class TfclawCommandRouter {
  private chatTerminalSelection = new Map<string, string>();
  private chatTmuxTarget = new Map<string, string>();
  private chatPassthroughEnabled = new Map<string, boolean>();
  private chatCaptureSelections = new Map<string, ChatCaptureSelection>();
  private chatOpenClawRouteScopes = new Map<string, OpenClawRouteScope>();
  private chatResolvedOpenClawRouteScopes = new Map<string, OpenClawRouteScope>();
  private chatModes = new Map<string, ChatInteractionMode>();
  private groupObservedUsers = new Map<string, Map<string, number>>();
  private progressSessions = new Map<string, TerminalProgressSession>();
  private commandProgressSessions = new Map<string, CommandProgressSession>();
  private activeCommandRequestBySelection = new Map<string, string>();
  private inboundMessageQueues = new Map<string, Promise<void>>();
  private readonly progressPollMs = 1200;
  private readonly groupObservedUserTtlMs = 24 * 60 * 60 * 1000;
  private readonly groupObservedUserMax = 256;
  private readonly progressRecallDelayMs = Math.max(
    80,
    Math.min(2000, toNumber(process.env.TFCLAW_PROGRESS_RECALL_DELAY_MS, 350)),
  );
  private readonly progressIdleTimeoutMs = 10 * 60 * 1000;
  private readonly progressMaxLifetimeMs = 30 * 60 * 1000;

  constructor(
    private readonly relay: RelayBridge,
    private readonly nexChatBridge: NexChatBridgeClient,
    private readonly openclawBridge: OpenClawPerUserBridge,
    private readonly accessManager: TfclawAccessManager,
  ) {}

  private selectionKey(channel: ChannelName, chatId: string, userKey?: string): string {
    if (!userKey) {
      return `${channel}:${chatId}`;
    }
    const normalized = userKey.trim() || "unknown";
    return `${channel}:${chatId}:${normalized}`;
  }

  private hasVoiceReplyIntent(text: string): boolean {
    const normalized = toString(text).trim();
    if (!normalized) {
      return false;
    }
    return /语音|音频|气泡语音|voice|tts|朗读|播报|念出来|说出来|读出来/i.test(normalized);
  }

  private buildTmuxSessionKey(linuxUser: string, homeDir: string): string {
    const encodedHome = Buffer.from(homeDir, "utf8").toString("base64url");
    return `tfu:${linuxUser}|h:${encodedHome}`;
  }

  private async resolveUserScope(ctx: InboundTextContext): Promise<RouterUserScope> {
    const senderKey = this.senderBufferKey(ctx);
    const resolvedUserKey = this.openclawBridge.resolveUserKeyFromRequest({
      senderId: ctx.senderId,
      senderOpenId: ctx.senderOpenId,
      senderUserId: ctx.senderUserId,
    }) || senderKey;
    const actorRole = await this.accessManager.getRole(resolvedUserKey);
    try {
      const scope = await this.openclawBridge.resolveExecutionScope({
        senderId: ctx.senderId,
        senderOpenId: ctx.senderOpenId,
        senderUserId: ctx.senderUserId,
      });
      const tmuxSessionKey = actorRole === "admin" || actorRole === "super_root"
        ? this.buildTmuxSessionKey("root", "/")
        : this.buildTmuxSessionKey(scope.linuxUser, scope.homeDir);
      return {
        senderKey,
        userKey: scope.userKey || senderKey,
        linuxUser: scope.linuxUser,
        actorRole,
        tmuxSessionKey,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (senderKey !== "unknown") {
        console.warn(`[gateway] failed to resolve user scope for tmux control: ${msg}`);
      }
      const senderHash = createHash("sha1").update(senderKey || "unknown").digest("hex").slice(0, 12);
      const fallbackHome = `/tmp/tfclaw-unresolved-${senderHash}`;
      return {
        senderKey,
        userKey: resolvedUserKey || senderKey,
        linuxUser: "unknown",
        actorRole,
        tmuxSessionKey: this.buildTmuxSessionKey("tfclaw_nouser", fallbackHome),
      };
    }
  }

  private getMode(selectionKey: string): ChatInteractionMode {
    return this.chatModes.get(selectionKey) ?? "tfclaw";
  }

  private hasExplicitSharedVoiceSkillRequest(text: string): boolean {
    const normalized = toString(text).trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return /moss[-\s_]?tts[-\s_]?voice|moss[-\s_]?voice[-\s_]?tts/.test(normalized);
  }

  private buildVoiceSkillDirective(text: string): string {
    if (!this.hasExplicitSharedVoiceSkillRequest(text)) {
      return "";
    }
    return [
      "",
      "[Bridge directive]",
      "用户已明确指定共享语音 skill。",
      "本轮禁止调用内置 tts 工具生成最终语音。",
      "优先使用共享技能 moss-tts-voice。",
      "若语音生成失败，不要输出空的 MEDIA 或占位路径；改为返回 1-2 句纯中文祝福正文，交由上层补救。",
    ].join("\n");
  }

  private setMode(selectionKey: string, mode: ChatInteractionMode): void {
    if (mode === "tfclaw") {
      this.chatModes.delete(selectionKey);
      if (!this.chatPassthroughEnabled.get(selectionKey)) {
        this.chatTmuxTarget.delete(selectionKey);
      }
      this.stopProgressSession(selectionKey);
      return;
    }
    this.chatModes.set(selectionKey, mode);
  }

  private selectedTerminal(selectionKey: string, requireActive: boolean): TerminalSummary | undefined {
    const selectedId = this.chatTerminalSelection.get(selectionKey);
    if (!selectedId) {
      return undefined;
    }
    const terminal = this.relay.cache.terminals.get(selectedId);
    if (!terminal) {
      return undefined;
    }
    if (requireActive && !terminal.isActive) {
      return undefined;
    }
    return terminal;
  }

  private modeTag(selectionKey: string): string {
    const passthroughEnabled = Boolean(this.chatPassthroughEnabled.get(selectionKey));
    const tmuxTarget = this.chatTmuxTarget.get(selectionKey);
    if (passthroughEnabled) {
      return `tmux:${tmuxTarget || "target"}`;
    }

    const mode = this.getMode(selectionKey);
    if (mode === "tfclaw") {
      return "tfclaw";
    }

    if (tmuxTarget) {
      return `tmux:${tmuxTarget}`;
    }

    const selected = this.selectedTerminal(selectionKey, false);
    if (selected) {
      return `terminal:${selected.title} (${selected.terminalId})`;
    }
    const selectedId = this.chatTerminalSelection.get(selectionKey);
    return selectedId ? `terminal:${selectedId}` : "terminal";
  }

  private buildDefaultGroupRouteScope(chatId: string): OpenClawRouteScope {
    const normalizedChatId = chatId.trim() || "unknown";
    return {
      kind: "group",
      modeLabel: normalizedChatId,
      routingUserKey: `${TFCLAW_GROUP_CHAT_SCOPE_PREFIX}${normalizedChatId}`,
    };
  }

  private openclawModeTag(selectionKey: string): string {
    const selectedRoute = this.chatOpenClawRouteScopes.get(selectionKey);
    const resolvedRoute = this.chatResolvedOpenClawRouteScopes.get(selectionKey);
    const route = resolvedRoute ?? selectedRoute;
    if (route?.kind === "group") {
      const label = route.modeLabel.trim() || "group";
      return `group:${label}`;
    }
    if (route?.kind === "personal") {
      const label = route.modeLabel.trim() || "user";
      return `user:${label}`;
    }
    return "user";
  }

  private isTmuxMode(selectionKey: string): boolean {
    const mode = this.getMode(selectionKey);
    const passthroughEnabled = Boolean(this.chatPassthroughEnabled.get(selectionKey));
    return mode === "terminal" || passthroughEnabled;
  }

  private senderBufferKey(ctx: InboundTextContext): string {
    return (ctx.senderUserId || ctx.senderOpenId || ctx.senderId || "unknown").trim() || "unknown";
  }

  private isGroupChat(ctx: InboundTextContext): boolean {
    return ctx.chatType.trim().toLowerCase() === "group";
  }

  private hasPendingCaptureSelection(selectionKey: string): boolean {
    return this.chatCaptureSelections.has(selectionKey);
  }

  private isTmuxControlCommand(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    if (!trimmed) {
      return false;
    }
    if (trimmed.startsWith("/tmux") || trimmed.startsWith("/passthrough") || trimmed.startsWith("/pt")) {
      return true;
    }
    const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
    return TMUX_SHORT_ALIAS_COMMANDS.has(firstToken);
  }

  private recordGroupObservedUsers(chatId: string, userKeys: string[]): void {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }
    const now = Date.now();
    const next = new Map<string, number>();
    const current = this.groupObservedUsers.get(normalizedChatId);
    if (current) {
      for (const [key, ts] of current.entries()) {
        if (!key || now - ts > this.groupObservedUserTtlMs) {
          continue;
        }
        next.set(key, ts);
      }
    }
    for (const rawKey of userKeys) {
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      next.set(key, now);
    }
    if (next.size > this.groupObservedUserMax) {
      const sorted = Array.from(next.entries()).sort((a, b) => b[1] - a[1]).slice(0, this.groupObservedUserMax);
      this.groupObservedUsers.set(normalizedChatId, new Map(sorted));
      return;
    }
    this.groupObservedUsers.set(normalizedChatId, next);
  }

  private parseMentionedUserKeys(ctx: InboundTextContext): string[] {
    const keys = (ctx.mentions ?? [])
      .map((mention) => (mention.openId || mention.userId || "").trim())
      .filter(Boolean);
    return dedupeStrings(keys);
  }

  private registerObservedGroupParticipants(ctx: InboundTextContext, userScope: RouterUserScope): void {
    if (!this.isGroupChat(ctx)) {
      return;
    }
    const mentionKeys = this.parseMentionedUserKeys(ctx);
    this.recordGroupObservedUsers(ctx.chatId, [userScope.userKey, ...mentionKeys]);
  }

  private async resolveFanoutUserKeysForGroup(chatId: string, fallbackUserKey: string): Promise<string[]> {
    const normalizedChatId = chatId.trim();
    const fallback = fallbackUserKey.trim();
    const now = Date.now();
    const observed = this.groupObservedUsers.get(normalizedChatId);
    const observedKeys: string[] = [];
    if (observed) {
      const next = new Map<string, number>();
      for (const [key, ts] of observed.entries()) {
        if (!key || now - ts > this.groupObservedUserTtlMs) {
          continue;
        }
        next.set(key, ts);
        observedKeys.push(key);
      }
      if (next.size > 0) {
        this.groupObservedUsers.set(normalizedChatId, next);
      } else {
        this.groupObservedUsers.delete(normalizedChatId);
      }
    }
    const candidates = dedupeStrings([fallback, ...observedKeys]);
    if (candidates.length === 0) {
      return [];
    }
    try {
      const bindings = await this.openclawBridge.listUserBindings();
      const known = new Set(bindings.map((item) => item.userKey.trim()).filter(Boolean));
      const scoped = candidates.filter((item) => known.has(item));
      if (scoped.length > 0) {
        return scoped;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[gateway] failed to load openclaw user bindings for group fanout: ${msg}`);
    }
    return fallback ? [fallback] : [];
  }

  private formatSilentGroupMessageForOpenClaw(ctx: InboundTextContext, fallbackUserKey: string, text: string): string {
    const payload = text.trim();
    if (!payload) {
      return "";
    }
    const speaker = (
      ctx.senderName
      || ctx.senderUserId
      || ctx.senderOpenId
      || ctx.senderId
      || fallbackUserKey
      || "unknown"
    ).trim();
    return `[${speaker}] ${payload}`;
  }

  private async fanoutGroupMessageToOpenClaw(
    ctx: InboundTextContext,
    text: string,
    targetUserKeys: string[],
  ): Promise<void> {
    if (!this.openclawBridge.enabled) {
      return;
    }
    const messageText = text.trim();
    if (!messageText) {
      return;
    }
    const targets = dedupeStrings(targetUserKeys.map((item) => item.trim()).filter(Boolean));
    if (targets.length === 0) {
      return;
    }
    const tasks = targets.map(async (targetUserKey) => {
      const targetSelectionKey = this.selectionKey(ctx.channel, ctx.chatId, targetUserKey);
      await this.routeToOpenClaw(
        {
          ...ctx,
          text: messageText,
          llmText: messageText,
        },
        targetSelectionKey,
        {
          text: messageText,
          routingUserKey: targetUserKey,
          modeLabel: targetUserKey,
          silent: true,
        },
      );
    });
    await Promise.allSettled(tasks);
  }

  private async ingestSilentGroupMessageToOpenClawContexts(
    ctx: InboundTextContext,
    userScope: RouterUserScope,
    text: string,
  ): Promise<void> {
    const formatted = this.formatSilentGroupMessageForOpenClaw(ctx, userScope.userKey, text);
    if (!formatted) {
      return;
    }
    const selectionKey = this.selectionKey(ctx.channel, ctx.chatId, userScope.userKey);
    const routeScope = await this.resolveOpenClawRouteScope(selectionKey, userScope, ctx);
    await this.routeToOpenClaw(
      {
        ...ctx,
        text: formatted,
        llmText: formatted,
      },
      selectionKey,
      {
        text: formatted,
        routingUserKey: routeScope.routingUserKey,
        workspaceOverrideDir: routeScope.workspaceOverrideDir,
        modeLabel: routeScope.modeLabel,
        modeKind: routeScope.kind === "group" ? "group" : "user",
        silent: true,
      },
    );
  }

  private isTfclawPresetCommand(text: string, selectionKey?: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const lowered = trimmed.toLowerCase();
    if (lowered.startsWith("/tmux") || lowered.startsWith("/passthrough") || lowered.startsWith("/pt")) {
      return true;
    }

    const firstToken = lowered.split(/\s+/, 1)[0] ?? "";
    if (TMUX_SHORT_ALIAS_COMMANDS.has(firstToken)) {
      return true;
    }

    if (trimmed.startsWith("/")) {
      return /^\/(?:tfhelp|tfstate|tflist|tfnew|tfcapture|tfattach|tfkey|tfctrlc|tfctrld|tfuse|tfclose)(?:\s+|$)/i.test(trimmed);
    }

    if (["help", "state", "list", "new", "capture", "ctrlc", "ctrld"].includes(lowered)) {
      return true;
    }
    if (/^(?:attach|key|use|close)\s+\S+/i.test(trimmed)) {
      return true;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const maybeTerminalRef = trimmed.slice(0, colonIndex).trim();
      if (maybeTerminalRef && this.resolveTerminal(maybeTerminalRef, selectionKey)) {
        return true;
      }
    }

    return false;
  }

  private rewriteTfclawSlashCommandToLegacy(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return text;
    }
    const firstSpace = trimmed.indexOf(" ");
    const token = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
    const args = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
    const mapped = TFCLAW_SLASH_COMMAND_ALIAS_TO_LEGACY[token];
    if (!mapped) {
      return text;
    }
    return args ? `${mapped} ${args}` : mapped;
  }

  private normalizeTfclawCommandAlias(cmd: string): string {
    const lowered = cmd.trim().toLowerCase();
    switch (lowered) {
      case "tfhelp":
        return "help";
      case "tfstate":
        return "state";
      case "tflist":
        return "list";
      case "tfnew":
        return "new";
      case "tfcapture":
        return "capture";
      case "tfattach":
        return "attach";
      case "tfkey":
        return "key";
      case "tfctrlc":
        return "ctrlc";
      case "tfctrld":
        return "ctrld";
      case "tfuse":
        return "use";
      case "tfclose":
        return "close";
      default:
        return lowered;
    }
  }

  private normalizeCommandLine(line: string): string {
    return line.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private extractTmuxTarget(output: string): string | undefined {
    const source = output.trim();
    if (!source) {
      return undefined;
    }

    const header = source.match(/\[tmux ([^\]\r\n]+)\]/i);
    if (header?.[1]) {
      return header[1].trim();
    }

    const targetSet = source.match(/target set to `([^`]+)`/i);
    if (targetSet?.[1]) {
      return targetSet[1].trim();
    }

    const statusTarget = source.match(/- target:\s*([^\r\n]+)/i);
    if (statusTarget?.[1]) {
      const target = statusTarget[1].trim();
      if (target && target !== "(not set)") {
        return target;
      }
    }

    return undefined;
  }

  private updateModeFromResult(selectionKey: string, rawCommand: string, output: string): void {
    const command = this.normalizeCommandLine(rawCommand);
    const target = this.extractTmuxTarget(output);
    if (target) {
      this.chatTmuxTarget.set(selectionKey, target);
    }

    const passthroughOnCommand =
      command === "/passthrough on" || command === "/passthrough enable" || command === "/pt on";
    const passthroughOffCommand =
      command === "/passthrough off" || command === "/passthrough disable" || command === "/pt off";

    if (passthroughOnCommand) {
      if (/passthrough enabled/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, true);
        this.setMode(selectionKey, "terminal");
      }
      return;
    }

    if (passthroughOffCommand) {
      if (/passthrough disabled/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, false);
        this.setMode(selectionKey, "tfclaw");
      }
      return;
    }

    if (/tmux status:/i.test(output)) {
      if (/- passthrough:\s*on/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, true);
        this.setMode(selectionKey, "terminal");
      } else if (/- passthrough:\s*off/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, false);
        this.setMode(selectionKey, "tfclaw");
      }
    }
  }

  private normalizeLegacyErrorMessage(output: string): string {
    const source = output.trim();
    if (!source) {
      return source;
    }
    if (/unknown tfclaw command:/i.test(source)) {
      return "Unknown command. Use `/tmux help`.";
    }
    if (/use\s+\/help,\s*or\s*\/attach/i.test(source)) {
      return source.replace(/use\s+\/help,\s*or\s*\/attach[^\r\n]*/gi, "Use `/tmux help`.");
    }
    return this.rewriteTfclawHelpAliases(source);
  }

  private rewriteTfclawHelpAliases(output: string): string {
    if (!/tfclaw commands:/i.test(output)) {
      return output;
    }
    return output
      .replace(/\/help\b/g, "/tfhelp")
      .replace(/\/new\b/g, "/tfnew");
  }

  private normalizeForegroundCommand(command: string | undefined): string {
    const trimmed = (command ?? "").trim().toLowerCase();
    if (!trimmed) {
      return "";
    }
    const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
    return base.endsWith(".exe") ? base.slice(0, -4) : base;
  }

  private shouldEnableProgress(terminal: TerminalSummary | undefined): boolean {
    if (!terminal || !terminal.isActive) {
      return false;
    }
    const normalized = this.normalizeForegroundCommand(terminal.foregroundCommand);
    return normalized.length > 0 && REALTIME_FOREGROUND_COMMANDS.has(normalized);
  }

  private async replyWithMode(
    chatId: string,
    responder: MessageResponder,
    selectionKey: string,
    body: string,
    options?: {
      modeTagOverride?: string;
    },
  ): Promise<void> {
    await this.replyWithModeMeta(chatId, responder, selectionKey, body, options);
  }

  private async replyWithModeMeta(
    chatId: string,
    responder: MessageResponder,
    selectionKey: string,
    body: string,
    options?: {
      modeTagOverride?: string;
    },
  ): Promise<{ messageId?: string }> {
    const modeTag = (options?.modeTagOverride || this.modeTag(selectionKey)).trim() || this.modeTag(selectionKey);
    const head = `[mode] ${modeTag}`;
    const content = body.trim();
    const payload = content ? `${head}\n${content}` : head;
    if (typeof responder.replyTextWithMeta === "function") {
      return (await responder.replyTextWithMeta(chatId, payload)) ?? {};
    }
    await responder.replyText(chatId, payload);
    return {};
  }

  private stopProgressSession(selectionKey: string): void {
    const session = this.progressSessions.get(selectionKey);
    if (!session) {
      return;
    }
    clearInterval(session.timer);
    this.progressSessions.delete(selectionKey);
  }

  private scheduleDeleteMessage(responder: MessageResponder, messageId: string): void {
    if (!messageId || typeof responder.deleteMessage !== "function") {
      return;
    }
    setTimeout(() => {
      void responder
        .deleteMessage?.(messageId)
        .catch((error) => console.warn(`[gateway] feishu delete message failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.progressRecallDelayMs);
  }

  private async sendProgressUpdate(session: TerminalProgressSession, body: string): Promise<void> {
    const previousMessageId = session.lastProgressMessageId;
    const meta = await this.replyWithModeMeta(session.chatId, session.responder, session.selectionKey, body);
    const currentMessageId = meta.messageId;
    if (currentMessageId) {
      session.lastProgressMessageId = currentMessageId;
      if (previousMessageId && previousMessageId !== currentMessageId) {
        this.scheduleDeleteMessage(session.responder, previousMessageId);
      }
    }
  }

  private beginCommandProgressSession(
    selectionKey: string,
    requestId: string,
    chatId: string,
    responder: MessageResponder,
  ): void {
    const previousRequestId = this.activeCommandRequestBySelection.get(selectionKey);
    if (previousRequestId && previousRequestId !== requestId) {
      this.stopCommandProgressSession(previousRequestId, true);
    }

    this.activeCommandRequestBySelection.set(selectionKey, requestId);
    this.commandProgressSessions.set(requestId, {
      requestId,
      selectionKey,
      chatId,
      responder,
      queue: Promise.resolve(),
    });
  }

  private stopCommandProgressSession(requestId: string, recallLastMessage: boolean): void {
    const session = this.commandProgressSessions.get(requestId);
    if (!session) {
      return;
    }
    this.commandProgressSessions.delete(requestId);

    if (this.activeCommandRequestBySelection.get(session.selectionKey) === requestId) {
      this.activeCommandRequestBySelection.delete(session.selectionKey);
    }

    if (recallLastMessage && session.lastProgressMessageId && typeof session.responder.deleteMessage === "function") {
      void session.responder
        .deleteMessage(session.lastProgressMessageId)
        .catch((error) => console.warn(`[gateway] feishu delete message failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private queueCommandProgressUpdate(requestId: string, body: string): void {
    const session = this.commandProgressSessions.get(requestId);
    if (!session) {
      return;
    }
    const nextBody = body.trim();
    if (!nextBody) {
      return;
    }

    session.queue = session.queue
      .catch(() => undefined)
      .then(async () => {
        const active = this.commandProgressSessions.get(requestId);
        if (!active) {
          return;
        }
        if (this.activeCommandRequestBySelection.get(active.selectionKey) !== requestId) {
          return;
        }
        if (active.lastProgressBody === nextBody) {
          return;
        }

        const previousMessageId = active.lastProgressMessageId;
        const meta = await this.replyWithModeMeta(active.chatId, active.responder, active.selectionKey, nextBody);
        active.lastProgressBody = nextBody;
        const currentMessageId = meta.messageId;
        if (!currentMessageId) {
          return;
        }
        active.lastProgressMessageId = currentMessageId;
        if (previousMessageId && previousMessageId !== currentMessageId) {
          this.scheduleDeleteMessage(active.responder, previousMessageId);
        }
      })
      .catch((error) => console.warn(`[gateway] progress send failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async flushCommandProgressSession(requestId: string): Promise<void> {
    const session = this.commandProgressSessions.get(requestId);
    if (!session) {
      return;
    }
    try {
      await session.queue;
    } catch {
      // no-op
    }
  }

  private async replyWithModeReplacingCommandProgress(
    requestId: string,
    chatId: string,
    responder: MessageResponder,
    selectionKey: string,
    body: string,
  ): Promise<void> {
    await this.flushCommandProgressSession(requestId);
    const progressSession = this.commandProgressSessions.get(requestId);
    const previousProgressMessageId = progressSession?.lastProgressMessageId;
    const meta = await this.replyWithModeMeta(chatId, responder, selectionKey, body);
    if (previousProgressMessageId && (!meta.messageId || meta.messageId !== previousProgressMessageId)) {
      this.scheduleDeleteMessage(progressSession?.responder ?? responder, previousProgressMessageId);
    }
  }

  private startOrRefreshProgressSession(
    selectionKey: string,
    chatId: string,
    responder: MessageResponder,
    terminalId: string,
    baselineOutput?: string,
  ): void {
    const now = Date.now();
    const initialOutput = baselineOutput ?? this.relay.cache.snapshots.get(terminalId)?.output ?? "";
    const existing = this.progressSessions.get(selectionKey);

    if (existing && existing.terminalId === terminalId) {
      existing.chatId = chatId;
      existing.responder = responder;
      existing.lastSnapshot = initialOutput;
      existing.lastChangedAt = now;
      return;
    }

    if (existing) {
      this.stopProgressSession(selectionKey);
    }

    const session: TerminalProgressSession = {
      selectionKey,
      chatId,
      terminalId,
      responder,
      timer: setInterval(() => {
        void this.pollProgressSession(selectionKey);
      }, this.progressPollMs),
      lastSnapshot: initialOutput,
      lastChangedAt: now,
      startedAt: now,
      busy: false,
    };

    this.progressSessions.set(selectionKey, session);
  }

  private async pollProgressSession(selectionKey: string): Promise<void> {
    const session = this.progressSessions.get(selectionKey);
    if (!session || session.busy) {
      return;
    }
    session.busy = true;

    try {
      const now = Date.now();
      if (this.getMode(selectionKey) !== "terminal") {
        this.stopProgressSession(selectionKey);
        return;
      }
      if (now - session.startedAt > this.progressMaxLifetimeMs || now - session.lastChangedAt > this.progressIdleTimeoutMs) {
        this.stopProgressSession(selectionKey);
        return;
      }

      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected || selected.terminalId !== session.terminalId) {
        this.stopProgressSession(selectionKey);
        return;
      }

      const current = this.relay.cache.snapshots.get(session.terminalId)?.output ?? "";
      if (!this.shouldEnableProgress(selected)) {
        if (current !== session.lastSnapshot) {
          session.lastSnapshot = current;
          session.lastChangedAt = now;
        }
        return;
      }

      if (current === session.lastSnapshot) {
        return;
      }

      const delta = current.startsWith(session.lastSnapshot) ? current.slice(session.lastSnapshot.length) : current;
      session.lastSnapshot = current;
      session.lastChangedAt = now;

      const rendered = this.renderOutputForChat(delta, 1800);
      if (rendered === "(no output yet)") {
        return;
      }

      const terminalTitle = selected.title || session.terminalId;
      await this.sendProgressUpdate(session, `# ${terminalTitle} [progress]\n${rendered}`);
    } catch (error) {
      console.warn(`[gateway] progress poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const latest = this.progressSessions.get(selectionKey);
      if (latest) {
        latest.busy = false;
      }
    }
  }

  private resolveTerminal(input: string, _selectionKey?: string): TerminalSummary | undefined {
    const normalized = input.trim();
    if (!normalized) {
      return undefined;
    }

    if (this.relay.cache.terminals.has(normalized)) {
      return this.relay.cache.terminals.get(normalized);
    }

    for (const terminal of this.relay.cache.terminals.values()) {
      if (terminal.title === normalized) {
        return terminal;
      }
    }

    const numeric = Number.parseInt(normalized, 10);
    if (Number.isInteger(numeric) && numeric > 0) {
      const list = Array.from(this.relay.cache.terminals.values());
      return list[numeric - 1];
    }

    return undefined;
  }

  private firstActiveTerminal(_selectionKey?: string): TerminalSummary | undefined {
    for (const terminal of this.relay.cache.terminals.values()) {
      if (terminal.isActive) {
        return terminal;
      }
    }
    return undefined;
  }

  private snapshotToLiveFrame(raw: string): string {
    const rendered = renderTerminalStream(raw);
    if (!rendered.text) {
      return "";
    }

    const lines = rendered.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return "";
    }

    return lines[lines.length - 1] ?? "";
  }

  private renderOutputForChat(raw: string, maxChars = 2200, extraLiveFrames: string[] = []): string {
    const rendered = renderTerminalStream(raw);
    let body = rendered.text || "(no output yet)";
    if (body.length > maxChars) {
      body = body.slice(-maxChars);
    }

    const frames: string[] = [];
    for (const frame of [...rendered.dynamicFrames, ...extraLiveFrames]) {
      const cleaned = trimRenderedLine(frame);
      if (!cleaned) {
        continue;
      }
      if (frames.length > 0 && frames[frames.length - 1] === cleaned) {
        continue;
      }
      frames.push(cleaned);
    }

    if (frames.length >= 1) {
      const sampled = frames.slice(-8).join("\n");
      const maxDynamicChars = 900;
      const dynamicText = sampled.length > maxDynamicChars ? sampled.slice(-maxDynamicChars) : sampled;
      body = `${body}\n\n[live]\n${dynamicText}`;
    }

    return body;
  }

  private async collectCommandOutput(terminalId: string): Promise<string> {
    const before = this.relay.cache.snapshots.get(terminalId)?.output ?? "";
    const startAt = Date.now();
    let lastValue = before;
    let lastChangeAt = startAt;
    const liveFrames: string[] = [];

    const pushLiveFrame = (raw: string) => {
      const frame = this.snapshotToLiveFrame(raw);
      if (!frame) {
        return;
      }
      if (liveFrames.length > 0 && liveFrames[liveFrames.length - 1] === frame) {
        return;
      }
      liveFrames.push(frame);
      if (liveFrames.length > 24) {
        liveFrames.splice(0, liveFrames.length - 24);
      }
    };

    const maxWaitMs = 12000;
    const pollMs = 250;
    const settleMs = 1200;

    pushLiveFrame(before);

    while (Date.now() - startAt < maxWaitMs) {
      await delay(pollMs);
      const current = this.relay.cache.snapshots.get(terminalId)?.output ?? "";
      if (current !== lastValue) {
        lastValue = current;
        lastChangeAt = Date.now();
        pushLiveFrame(current);
        continue;
      }
      if (Date.now() - lastChangeAt >= settleMs && Date.now() - startAt >= settleMs) {
        break;
      }
    }

    const after = this.relay.cache.snapshots.get(terminalId)?.output ?? "";
    pushLiveFrame(after);
    const delta = after.startsWith(before) ? after.slice(before.length) : after;
    const renderedDelta = renderTerminalStream(delta);
    if (renderedDelta.text || renderedDelta.dynamicFrames.length > 0) {
      return this.renderOutputForChat(delta, 2200, liveFrames);
    }
    return this.renderOutputForChat(after, 2200, liveFrames);
  }

  private tfclawHelpText(): string {
    return [
      "TFClaw mode commands:",
      "1) /tflist (or list) - list terminals",
      "2) /tfnew (or new) - create terminal",
      "3) /tfuse <id|title|index> - select terminal",
      "4) /tfattach [id|title|index] - enter terminal mode",
      "5) /tfclose <id|title|index> - close terminal",
      "6) /tfcapture - list screens/windows and choose by number",
      "7) reply number after /tfcapture - capture selected source",
      "8) <terminal-id>: <command> - run one command in specified terminal",
      "9) /tfstate - show current mode",
      "10) /tfkey <enter|tab|esc|ctrl+c|ctrl+d|ctrl+z|ctrl+letter> - send one key to terminal",
      "11) in terminal mode, use .tf <command> to run tfclaw commands",
      "12) /tfroot show - display super_root (set via local file only, /tfroot set disabled)",
      "13) /tfadmin list|add|remove ... - manage admin users (add/remove: super_root only)",
      "14) /tfusers - list all users and roles (admin/super_root)",
      "15) /tfgroup list|create|workspace|add|remove ... - manage groups",
      "16) /tfmode status|list|personal|group [groupName] - switch personal/group openclaw",
      "17) user target in /tfadmin add/remove and /tfgroup add/remove supports: feishuId | feishuName | linuxUser | me",
      "18) /tfenv list|set|unset ... - manage your private openclaw env vars",
      "19) /tfapikey <ENV_KEY> <api_key> - save API key into your private env vars",
      "20) /tf status|user|group|reset - quick switch in current chat (group chat default target is group bot)",
    ].join("\n");
  }

  private terminalHelpText(): string {
    return [
      "Terminal mode:",
      "1) any message -> sent to tmux terminal input",
      "2) .ctrlc / .ctrld / /key <key> -> send one key to terminal",
      "3) .exit -> back to tfclaw mode",
      "4) .tf <command> (or /tf <command>) -> run tfclaw command in terminal mode",
      "5) progress output is auto-polled only for realtime commands (node/npm/pnpm/yarn...)",
    ].join("\n");
  }

  private keyUsageText(prefix = "/key"): string {
    return `usage: ${prefix} <enter|tab|esc|ctrl+c|ctrl+d|ctrl+z|ctrl+letter>`;
  }

  private parseKeyInput(spec: string): { data: string; label: string } | undefined {
    const trimmed = spec.trim();
    if (!trimmed) {
      return undefined;
    }

    const normalized = trimmed.toLowerCase().replace(/\s+/g, "");
    if (normalized === "enter" || normalized === "return") {
      return { data: "__ENTER__", label: "enter" };
    }
    if (normalized === "tab") {
      return { data: "\t", label: "tab" };
    }
    if (normalized === "esc" || normalized === "escape") {
      return { data: "\x1b", label: "esc" };
    }
    if (normalized === "space") {
      return { data: " ", label: "space" };
    }
    if (normalized === "ctrlc" || normalized === "ctrl+c" || normalized === "ctrl-c" || normalized === "^c") {
      return { data: "__CTRL_C__", label: "ctrl+c" };
    }
    if (normalized === "ctrld" || normalized === "ctrl+d" || normalized === "ctrl-d" || normalized === "^d") {
      return { data: "__CTRL_D__", label: "ctrl+d" };
    }
    if (normalized === "ctrlz" || normalized === "ctrl+z" || normalized === "ctrl-z" || normalized === "^z") {
      return { data: "__CTRL_Z__", label: "ctrl+z" };
    }

    const ctrlMatch = normalized.match(/^(?:ctrl[+-]|\^)([a-z])$/);
    if (ctrlMatch) {
      const letter = ctrlMatch[1];
      const code = letter.charCodeAt(0) - 96;
      if (code >= 1 && code <= 26) {
        return {
          data: String.fromCharCode(code),
          label: `ctrl+${letter}`,
        };
      }
    }

    return undefined;
  }

  private async sendKeyToTerminal(
    ctx: InboundTextContext,
    selectionKey: string,
    terminal: TerminalSummary,
    keySpec: string,
    usagePrefix: string,
  ): Promise<boolean> {
    const parsed = this.parseKeyInput(keySpec);
    if (!parsed) {
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.keyUsageText(usagePrefix));
      return false;
    }

    this.relay.command({
      command: "terminal.input",
      terminalId: terminal.terminalId,
      data: parsed.data,
    });
    const rendered = await this.collectCommandOutput(terminal.terminalId);
    await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `[key] ${parsed.label}\n# ${terminal.title}\n${rendered}`);
    const baseline = this.relay.cache.snapshots.get(terminal.terminalId)?.output ?? "";
    this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, terminal.terminalId, baseline);
    return true;
  }

  private parseCommandLine(line: string): { cmd: string; args: string } {
    const normalized = line.startsWith("/") ? line.slice(1).trim() : line.trim();
    const firstSpace = normalized.indexOf(" ");
    if (firstSpace < 0) {
      return {
        cmd: normalized.toLowerCase(),
        args: "",
      };
    }
    return {
      cmd: normalized.slice(0, firstSpace).toLowerCase(),
      args: normalized.slice(firstSpace + 1).trim(),
    };
  }

  private normalizeCommandInputText(rawText: string): string {
    let text = rawText
      .replace(/\r/g, "")
      .replace(/[\u200b\u200c\u200d\ufeff]/g, " ")
      .replace(/\u00a0/g, " ")
      .trim();
    if (!text) {
      return "";
    }
    // Group messages commonly start with Feishu mention tags. Strip leading mentions
    // so "/tmux ...", "/tfadmin ...", "/tfgroup ..." can be recognized by tfclaw.
    for (let idx = 0; idx < 8; idx += 1) {
      const next = text
        .replace(/^<at\b[^>]*>[\s\S]*?<\/at>(?:\s|[\u200b\u200c\u200d\ufeff])*/i, "")
        .replace(/^@\S+(?:\s|[\u200b\u200c\u200d\ufeff])+/, "")
        .trimStart();
      if (next === text) {
        break;
      }
      text = next;
      if (!text) {
        break;
      }
    }
    return text.trim();
  }

  private isTfclawManagedSlashCommand(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }
    const body = trimmed.slice(1).trim();
    if (!body) {
      return false;
    }
    const cmd = (body.split(/\s+/, 1)[0] ?? "").toLowerCase();
    return TFCLAW_MANAGED_SLASH_COMMANDS.has(cmd);
  }

  private displayLinuxUserFromMap(userKey: string, linuxUsers: Map<string, string>): string {
    const linuxUser = (linuxUsers.get(userKey) || "").trim();
    if (linuxUser) {
      return linuxUser;
    }
    return userKey;
  }

  private async displayLinuxUser(userKey: string): Promise<string> {
    const normalized = userKey.trim();
    if (!normalized) {
      return "unknown";
    }
    const bindings = await this.openclawBridge.listUserBindings();
    const hit = bindings.find((item) => item.userKey === normalized);
    return (hit?.linuxUser || normalized).trim();
  }

  private formatRole(role: TfclawUserRole): string {
    switch (role) {
      case "super_root":
        return "最高root";
      case "admin":
        return "管理员";
      default:
        return "普通用户";
    }
  }

  private normalizeTargetUserArg(arg: string, userScope: RouterUserScope): string {
    const normalized = arg.trim();
    if (!normalized) {
      return "";
    }
    const lowered = normalized.toLowerCase();
    if (lowered === "me" || lowered === "self" || lowered === "@me") {
      return userScope.userKey;
    }
    return normalized;
  }

  private looksLikeFeishuUserIdentifier(value: string): boolean {
    return /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(value.trim());
  }

  private async resolveTargetUserKey(arg: string, userScope: RouterUserScope): Promise<string | undefined> {
    const normalized = this.normalizeTargetUserArg(arg, userScope);
    if (!normalized) {
      return undefined;
    }
    const bindings = await this.openclawBridge.listUserBindings();
    const exactBinding = bindings.find((item) => item.userKey === normalized);
    if (exactBinding) {
      return exactBinding.userKey;
    }
    const linuxBinding = bindings.find((item) => item.linuxUser === normalized);
    if (linuxBinding) {
      return linuxBinding.userKey;
    }
    const aliasResolved = await this.accessManager.resolveUserAlias(normalized);
    if (aliasResolved) {
      return aliasResolved;
    }
    if (this.looksLikeFeishuUserIdentifier(normalized)) {
      return normalized;
    }
    return undefined;
  }

  private parseEnvSetArgs(raw: string): { key: string; value: string } | undefined {
    let body = raw.trim();
    body = body.replace(/^(?:set|add|put)\s+/i, "").trim();
    if (!body) {
      return undefined;
    }
    const eqIndex = body.indexOf("=");
    if (eqIndex > 0) {
      const key = body.slice(0, eqIndex).trim();
      const value = body.slice(eqIndex + 1).trim();
      if (!key || !value) {
        return undefined;
      }
      return { key, value };
    }
    const firstSpace = body.search(/\s/);
    if (firstSpace <= 0) {
      return undefined;
    }
    const key = body.slice(0, firstSpace).trim();
    const value = body.slice(firstSpace + 1).trim();
    if (!key || !value) {
      return undefined;
    }
    return { key, value };
  }

  private maskEnvValueForDisplay(key: string, value: string): string {
    if (key === "CLAWHUB_WORKDIR") {
      return value;
    }
    if (!value) {
      return "(empty)";
    }
    const upperKey = key.toUpperCase();
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)/.test(upperKey)) {
      if (value.length <= 6) {
        return "*".repeat(value.length);
      }
      return `${value.slice(0, 3)}***${value.slice(-2)}`;
    }
    if (value.length > 96) {
      return `${value.slice(0, 48)}...(len=${value.length})`;
    }
    return value;
  }

  private async resolveOpenClawRouteScope(
    selectionKey: string,
    userScope: RouterUserScope,
    ctx?: Pick<InboundTextContext, "chatId" | "chatType">,
  ): Promise<OpenClawRouteScope> {
    const selected = this.chatOpenClawRouteScopes.get(selectionKey);
    const personalLabel = await this.displayLinuxUser(userScope.userKey);
    if (selected?.kind === "personal") {
      const route: OpenClawRouteScope = {
        kind: "personal",
        modeLabel: personalLabel,
        routingUserKey: userScope.userKey,
      };
      this.chatResolvedOpenClawRouteScopes.set(selectionKey, route);
      return route;
    }
    if (selected?.kind === "group") {
      const route: OpenClawRouteScope = {
        kind: "group",
        modeLabel: selected.modeLabel.trim() || ctx?.chatId?.trim() || "group",
        routingUserKey: selected.routingUserKey.trim()
          || this.buildDefaultGroupRouteScope(ctx?.chatId || "unknown").routingUserKey,
        workspaceOverrideDir: selected.workspaceOverrideDir,
      };
      this.chatResolvedOpenClawRouteScopes.set(selectionKey, route);
      return route;
    }

    const isGroupChat = (ctx?.chatType || "").trim().toLowerCase() === "group";
    if (isGroupChat) {
      const route = this.buildDefaultGroupRouteScope(ctx?.chatId || "unknown");
      this.chatResolvedOpenClawRouteScopes.set(selectionKey, route);
      return route;
    }

    const route: OpenClawRouteScope = {
      kind: "personal",
      modeLabel: personalLabel,
      routingUserKey: userScope.userKey,
    };
    this.chatResolvedOpenClawRouteScopes.set(selectionKey, route);
    return route;
  }

  private toAgentRouteOptions(route: OpenClawRouteScope): {
    routingUserKey?: string;
    workspaceOverrideDir?: string;
    modeLabel?: string;
  } {
    return {
      routingUserKey: route.routingUserKey,
      workspaceOverrideDir: route.workspaceOverrideDir,
      modeLabel: route.modeLabel,
    };
  }

  private async enqueueInboundMessageBySelection(
    selectionKey: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.inboundMessageQueues.get(selectionKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await task();
      });
    this.inboundMessageQueues.set(selectionKey, current);
    try {
      await current;
    } finally {
      if (this.inboundMessageQueues.get(selectionKey) === current) {
        this.inboundMessageQueues.delete(selectionKey);
      }
    }
  }

  private async handleAccessControlCommand(
    ctx: InboundTextContext,
    selectionKey: string,
    userScope: RouterUserScope,
    text: string,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }
    const body = trimmed.slice(1).trim();
    if (!body) {
      return false;
    }
    const [cmdRaw, ...rest] = body.split(/\s+/);
    const cmd = (cmdRaw ?? "").toLowerCase();
    const argsText = rest.join(" ").trim();

    if (cmd === "tf") {
      const [actionRaw] = argsText.split(/\s+/, 2);
      const action = (actionRaw ?? "status").toLowerCase();
      const isGroupChat = this.isGroupChat(ctx);
      const knownActions = new Set([
        "status",
        "show",
        "user",
        "personal",
        "private",
        "group",
        "shared",
        "default",
        "reset",
        "auto",
        "help",
      ]);
      if (!knownActions.has(action)) {
        // Keep legacy terminal-mode "/tf <command>" behavior.
        if (this.isTmuxMode(selectionKey)) {
          return false;
        }
      }

      if (action === "status" || action === "show") {
        const mode = await this.resolveOpenClawRouteScope(selectionKey, userScope, ctx);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode: ${mode.kind === "group" ? `group:${mode.modeLabel}` : `user:${mode.modeLabel}`}`,
        );
        return true;
      }

      if (action === "user" || action === "personal" || action === "private") {
        const selfDisplayName = await this.displayLinuxUser(userScope.userKey);
        this.chatOpenClawRouteScopes.set(selectionKey, {
          kind: "personal",
          modeLabel: selfDisplayName,
          routingUserKey: userScope.userKey,
        });
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode switched: user:${selfDisplayName}`,
        );
        return true;
      }

      if (action === "group" || action === "shared") {
        if (!isGroupChat) {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "group mode is only available in group chats");
          return true;
        }
        const groupRoute = this.buildDefaultGroupRouteScope(ctx.chatId);
        this.chatOpenClawRouteScopes.set(selectionKey, groupRoute);
        await this.openclawBridge.resolveExecutionScope({
          routingUserKey: groupRoute.routingUserKey,
          senderId: undefined,
          senderOpenId: undefined,
          senderUserId: undefined,
        });
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode switched: group:${groupRoute.modeLabel}`,
        );
        return true;
      }

      if (action === "default" || action === "reset" || action === "auto") {
        this.chatOpenClawRouteScopes.delete(selectionKey);
        const mode = await this.resolveOpenClawRouteScope(selectionKey, userScope, ctx);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode reset: ${mode.kind === "group" ? `group:${mode.modeLabel}` : `user:${mode.modeLabel}`}`,
        );
        return true;
      }

      if (action === "help" || !knownActions.has(action)) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          [
            "usage:",
            "/tf status",
            "/tf user",
            "/tf group",
            "/tf reset",
          ].join("\n"),
        );
        return true;
      }
      return false;
    }

    if (cmd === "tfapikey") {
      const parsed = this.parseEnvSetArgs(argsText);
      if (!parsed) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          "usage: /tfapikey <ENV_KEY> <api_key>\nexample: /tfapikey OPENAI_API_KEY sk-xxx",
        );
        return true;
      }
      try {
        const saved = await this.openclawBridge.setUserPrivateEnvVar(
          userScope.userKey,
          parsed.key,
          parsed.value,
        );
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `private api key saved: ${saved.key} (value hidden)\nopenclaw restarted for this user\nenv file: ${saved.envFilePath}`,
        );
      } catch (error) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `tfapikey failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return true;
    }

    if (cmd === "tfenv") {
      const trimmedArgs = argsText.trim();
      const [actionRaw, ...restArgs] = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
      const action = (actionRaw ?? "list").toLowerCase();

      if (!trimmedArgs || action === "list" || action === "ls" || action === "show" || action === "status") {
        try {
          const envInfo = await this.openclawBridge.listUserPrivateEnvVars(userScope.userKey);
          const rows = Object.entries(envInfo.vars)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `- ${key}=${this.maskEnvValueForDisplay(key, value)}`);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            rows.length > 0 ? `private env vars:\n${rows.join("\n")}\nenv file: ${envInfo.envFilePath}` : "private env vars: (none)",
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfenv list failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      if (action === "unset" || action === "remove" || action === "rm" || action === "delete") {
        const key = restArgs.join(" ").trim();
        if (!key) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfenv unset <ENV_KEY>",
          );
          return true;
        }
        try {
          const result = await this.openclawBridge.unsetUserPrivateEnvVar(userScope.userKey, key);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            result.removed
              ? `private env removed: ${result.key}\nopenclaw restarted for this user\nenv file: ${result.envFilePath}`
              : `private env not set: ${result.key}\nenv file: ${result.envFilePath}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfenv unset failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      const parsed = this.parseEnvSetArgs(trimmedArgs);
      if (!parsed) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          [
            "usage:",
            "/tfenv list",
            "/tfenv set <ENV_KEY> <value>",
            "/tfenv set <ENV_KEY>=<value>",
            "/tfenv unset <ENV_KEY>",
            "/tfapikey <ENV_KEY> <api_key>",
          ].join("\n"),
        );
        return true;
      }
      try {
        const saved = await this.openclawBridge.setUserPrivateEnvVar(
          userScope.userKey,
          parsed.key,
          parsed.value,
        );
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `private env saved: ${saved.key} (value hidden)\nopenclaw restarted for this user\nenv file: ${saved.envFilePath}`,
        );
      } catch (error) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `tfenv set failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return true;
    }

    if (cmd === "tfroot") {
      const [actionRaw] = argsText.split(/\s+/, 2);
      const action = (actionRaw ?? "show").toLowerCase();
      if (action === "show" || action === "who" || action === "status") {
        const rootUser = await this.accessManager.getSuperRootUserKey();
        const rootDisplayName = rootUser ? await this.displayLinuxUser(rootUser) : "";
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          rootUser ? `super_root: ${rootDisplayName}` : "super_root: (unset)",
        );
        return true;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "tfroot set is disabled. configure super_root in local file: <stateDir>/super-root.local.json",
      );
      return true;
    }

    if (cmd === "tfadmin") {
      const [actionRaw, targetRaw] = argsText.split(/\s+/, 2);
      const action = (actionRaw ?? "").toLowerCase();
      if (action === "list" || action === "users" || action === "status") {
        if (userScope.actorRole === "user") {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "permission denied: admin/super_root only");
          return true;
        }
        const bindings = await this.openclawBridge.listUserBindings();
        const linuxUsers = new Map(bindings.map((item) => [item.userKey, item.linuxUser]));
        const roles = await this.accessManager.listUsersWithRoles(bindings.map((item) => item.userKey));
        const lines = roles.map((item) => `- ${this.displayLinuxUserFromMap(item.userKey, linuxUsers)} | ${this.formatRole(item.role)}`);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          lines.length > 0 ? `system users:\n${lines.join("\n")}` : "system users: (none)",
        );
        return true;
      }
      if (action === "add" || action === "remove") {
        const targetUser = await this.resolveTargetUserKey(targetRaw ?? "", userScope);
        if (!targetUser) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfadmin add|remove <feishuId|feishuName|linuxUser|me>",
          );
          return true;
        }
        try {
          await this.accessManager.setAdmin(userScope.userKey, targetUser, action === "add");
          const targetDisplayName = await this.displayLinuxUser(targetUser);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `${action === "add" ? "admin granted" : "admin revoked"}: ${targetDisplayName}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfadmin failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "usage: /tfadmin list | /tfadmin add <feishuId|feishuName|linuxUser> | /tfadmin remove <feishuId|feishuName|linuxUser>",
      );
      return true;
    }

    if (cmd === "tfusers") {
      if (userScope.actorRole === "user") {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "permission denied: admin/super_root only");
        return true;
      }
      const bindings = await this.openclawBridge.listUserBindings();
      const linuxUsers = new Map(bindings.map((item) => [item.userKey, item.linuxUser]));
      const roles = await this.accessManager.listUsersWithRoles(bindings.map((item) => item.userKey));
      const rows = roles.map((item) =>
        `- ${this.displayLinuxUserFromMap(item.userKey, linuxUsers)} | ${this.formatRole(item.role)}`);
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        rows.length > 0 ? `system users:\n${rows.join("\n")}` : "system users: (none)",
      );
      return true;
    }

    if (cmd === "tfgroup") {
      const [actionRaw, ...restArgs] = argsText.split(/\s+/);
      const action = (actionRaw ?? "").toLowerCase();
      if (action === "list" || action === "ls") {
        const role = userScope.actorRole;
        const groups = role === "user"
          ? await this.accessManager.listGroupsForUser(userScope.userKey)
          : await this.accessManager.listGroups();
        if (groups.length === 0) {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "groups: (none)");
          return true;
        }
        const lines = groups.map((group) =>
          `- ${group.displayName} (${group.name}) | members=${group.members.length} | workspace=${group.workspaceDir}`);
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `groups:\n${lines.join("\n")}`);
        return true;
      }

      if (action === "create") {
        const groupName = restArgs[0] ?? "";
        const workspacePath = restArgs.slice(1).join(" ").trim();
        if (!groupName) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfgroup create <groupName> [workspacePath]",
          );
          return true;
        }
        try {
          const group = await this.accessManager.createGroup(userScope.userKey, groupName, workspacePath || undefined);
          await this.openclawBridge.resolveExecutionScope({
            routingUserKey: group.scopeUserKey,
            senderId: undefined,
            senderOpenId: undefined,
            senderUserId: undefined,
          });
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `group created: ${group.displayName} (${group.name})\nworkspace: ${group.workspaceDir}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfgroup create failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      if (action === "workspace" || action === "set-workspace") {
        const groupName = restArgs[0] ?? "";
        const workspacePath = restArgs.slice(1).join(" ").trim();
        if (!groupName || !workspacePath) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfgroup workspace <groupName> <workspacePath>",
          );
          return true;
        }
        try {
          const group = await this.accessManager.setGroupWorkspace(userScope.userKey, groupName, workspacePath);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `group workspace updated: ${group.displayName}\nworkspace: ${group.workspaceDir}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfgroup workspace failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      if (action === "add" || action === "remove") {
        const groupName = restArgs[0] ?? "";
        const targetUser = await this.resolveTargetUserKey(restArgs[1] ?? "", userScope);
        if (!groupName || !targetUser) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfgroup add|remove <groupName> <feishuId|feishuName|linuxUser|me>",
          );
          return true;
        }
        try {
          const group = action === "add"
            ? await this.accessManager.addGroupMember(userScope.userKey, groupName, targetUser)
            : await this.accessManager.removeGroupMember(userScope.userKey, groupName, targetUser);
          const targetDisplayName = await this.displayLinuxUser(targetUser);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `group ${action === "add" ? "member added" : "member removed"}: ${group.displayName}\nmember: ${targetDisplayName}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfgroup ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        [
          "usage:",
          "/tfgroup list",
          "/tfgroup create <groupName> [workspacePath]",
          "/tfgroup workspace <groupName> <workspacePath>",
          "/tfgroup add <groupName> <feishuId|feishuName|linuxUser>",
          "/tfgroup remove <groupName> <feishuId|feishuName|linuxUser>",
        ].join("\n"),
      );
      return true;
    }

    if (cmd === "tfmode") {
      const [actionRaw, ...restArgs] = argsText.split(/\s+/);
      const action = (actionRaw ?? "status").toLowerCase();
      if (action === "status" || action === "show") {
        const mode = await this.resolveOpenClawRouteScope(selectionKey, userScope, ctx);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode: ${mode.kind === "group" ? `group:${mode.modeLabel}` : `user:${mode.modeLabel}`}`,
        );
        return true;
      }
      if (action === "list") {
        const groups = await this.accessManager.listGroupsForUser(userScope.userKey);
        const lines = groups.map((group) => `- ${group.displayName} (${group.name})`);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          lines.length > 0 ? `your groups:\n${lines.join("\n")}` : "your groups: (none)",
        );
        return true;
      }
      if (action === "personal" || action === "user") {
        const selfDisplayName = await this.displayLinuxUser(userScope.userKey);
        this.chatOpenClawRouteScopes.set(selectionKey, {
          kind: "personal",
          modeLabel: selfDisplayName,
          routingUserKey: userScope.userKey,
        });
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode switched: user:${selfDisplayName}`,
        );
        return true;
      }
      if (action === "group") {
        const groupName = restArgs[0] ?? "";
        if (!groupName) {
          if (!this.isGroupChat(ctx)) {
            await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /tfmode group <groupName>");
            return true;
          }
          const groupRoute = this.buildDefaultGroupRouteScope(ctx.chatId);
          this.chatOpenClawRouteScopes.set(selectionKey, groupRoute);
          await this.openclawBridge.resolveExecutionScope({
            routingUserKey: groupRoute.routingUserKey,
            senderId: undefined,
            senderOpenId: undefined,
            senderUserId: undefined,
          });
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `openclaw mode switched: group:${groupRoute.modeLabel}`,
          );
          return true;
        }
        const group = await this.accessManager.getGroupForMember(groupName, userScope.userKey);
        if (!group) {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `group unavailable: ${groupName}`);
          return true;
        }
        this.chatOpenClawRouteScopes.set(selectionKey, {
          kind: "group",
          modeLabel: group.name,
          routingUserKey: group.scopeUserKey,
          workspaceOverrideDir: group.workspaceDir,
        });
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode switched: group:${group.displayName}`,
        );
        return true;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "usage: /tfmode status|list|personal|group [groupName]",
      );
      return true;
    }

    return false;
  }

  private async handleTfclawCommand(
    ctx: InboundTextContext,
    selectionKey: string,
    cmd: string,
    args: string,
  ): Promise<boolean> {
    cmd = this.normalizeTfclawCommandAlias(cmd);
    if (cmd === "help") {
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.tfclawHelpText());
      return true;
    }

    if (cmd === "state") {
      const selected = this.selectedTerminal(selectionKey, false);
      const text = selected
        ? `selected terminal: ${selected.title} (${selected.terminalId})`
        : "selected terminal: (none)";
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, text);
      return true;
    }

    if (cmd === "list") {
      const terminals = Array.from(this.relay.cache.terminals.values());
      if (terminals.length === 0) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no terminals");
        return true;
      }
      const selected = this.chatTerminalSelection.get(selectionKey);
      const content = terminals
        .map((terminal, idx) => {
          const flag = selected === terminal.terminalId ? " *selected" : "";
          const foreground = this.normalizeForegroundCommand(terminal.foregroundCommand);
          const runtime = foreground ? ` cmd=${foreground}` : "";
          return `${idx + 1}. ${terminal.title} [${terminal.terminalId}] ${terminal.isActive ? "active" : "closed"}${runtime}${flag}`;
        })
        .join("\n");
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, content);
      return true;
    }

    if (cmd === "new") {
      this.relay.command({
        command: "terminal.create",
        title: `${ctx.channel}-${Date.now()}`,
      });
      await delay(500);
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "terminal.create sent");
      return true;
    }

    if (cmd === "capture") {
      await this.handleCaptureList(selectionKey, ctx.chatId, ctx.responder);
      return true;
    }

    if (cmd === "attach") {
      await this.enterTerminalMode(ctx, selectionKey, args || undefined);
      return true;
    }

    if (cmd === "key") {
      if (!args) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.keyUsageText("/tfkey"));
        return true;
      }
      const selected = this.selectedTerminal(selectionKey, true) ?? this.firstActiveTerminal(selectionKey);
      if (!selected) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no active terminal. use /tfnew then /tfattach.");
        return true;
      }
      this.chatTerminalSelection.set(selectionKey, selected.terminalId);
      await this.sendKeyToTerminal(ctx, selectionKey, selected, args, "/tfkey");
      return true;
    }

    if (cmd === "ctrlc" || cmd === "ctrld") {
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no selected terminal. use /tflist then /tfuse <id>");
        return true;
      }
      this.relay.command({
        command: "terminal.input",
        terminalId: selected.terminalId,
        data: cmd === "ctrlc" ? "__CTRL_C__" : "__CTRL_D__",
      });
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `/${cmd} sent`);
      return true;
    }

    if (cmd === "use") {
      if (!args) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /tfuse <id|title|index>");
        return true;
      }
      const terminal = this.resolveTerminal(args, selectionKey);
      if (!terminal) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal not found: ${args}`);
        return true;
      }
      this.chatTerminalSelection.set(selectionKey, terminal.terminalId);
      if (this.getMode(selectionKey) === "terminal" && terminal.isActive) {
        const baseline = this.relay.cache.snapshots.get(terminal.terminalId)?.output ?? "";
        this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, terminal.terminalId, baseline);
      }
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `selected: ${terminal.title} (${terminal.terminalId})`);
      return true;
    }

    if (cmd === "close") {
      const key = args || this.chatTerminalSelection.get(selectionKey);
      if (!key) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /tfclose <id|title|index>");
        return true;
      }
      const terminal = this.resolveTerminal(key, selectionKey);
      if (!terminal) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal not found: ${key}`);
        return true;
      }
      this.relay.command({
        command: "terminal.close",
        terminalId: terminal.terminalId,
      });
      if (this.chatTerminalSelection.get(selectionKey) === terminal.terminalId && this.getMode(selectionKey) === "terminal") {
        this.setMode(selectionKey, "tfclaw");
      }
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `close requested: ${terminal.title}`);
      return true;
    }

    return false;
  }

  private formatCaptureOptions(sources: CaptureSource[]): string {
    const lines = sources.map((source, idx) => `${idx + 1}. [${source.source}] ${source.label}`);
    return ["Select capture source and reply with number:", ...lines].join("\n");
  }

  private async enterTerminalMode(
    ctx: InboundTextContext,
    selectionKey: string,
    requestedRef?: string,
  ): Promise<void> {
    let terminal: TerminalSummary | undefined;

    if (requestedRef) {
      terminal = this.resolveTerminal(requestedRef, selectionKey);
      if (!terminal) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal not found: ${requestedRef}`);
        return;
      }
      if (!terminal.isActive) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal is closed: ${terminal.title}`);
        return;
      }
    } else {
      terminal = this.selectedTerminal(selectionKey, true) ?? this.firstActiveTerminal(selectionKey);
      if (!terminal) {
        const title = `${ctx.channel}-attach-${Date.now()}`;
        this.relay.command({
          command: "terminal.create",
          title,
        });

        const startAt = Date.now();
        while (Date.now() - startAt < 5000) {
          await delay(250);
          const created = Array.from(this.relay.cache.terminals.values()).find(
            (candidate) => candidate.isActive && candidate.title === title,
          );
          if (created) {
            terminal = created;
            break;
          }
        }
      }
    }

    if (!terminal) {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "no active terminal found. use /tfnew first, then /tfattach.",
      );
      return;
    }

    this.chatTerminalSelection.set(selectionKey, terminal.terminalId);
    this.setMode(selectionKey, "terminal");
    const snapshot = this.relay.cache.snapshots.get(terminal.terminalId)?.output ?? "";
    const rendered = this.renderOutputForChat(snapshot, 1200);
    await this.replyWithMode(
      ctx.chatId,
      ctx.responder,
      selectionKey,
      `entered terminal mode: ${terminal.title} (${terminal.terminalId})\nspecial: .ctrlc  .ctrld  /key enter  .exit\n\n# ${terminal.title}\n${rendered}`,
    );
    this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, terminal.terminalId, snapshot);
  }

  private async handleTerminalModeInput(
    ctx: InboundTextContext,
    selectionKey: string,
    line: string,
    originalText: string,
  ): Promise<void> {
    const lower = line.toLowerCase();

    if (lower === ".exit" || lower === ".quit") {
      this.setMode(selectionKey, "tfclaw");
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "left terminal mode. back to tfclaw.");
      return;
    }

    if (lower === ".help") {
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.terminalHelpText());
      return;
    }

    if (lower === ".ctrlc") {
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        this.setMode(selectionKey, "tfclaw");
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "selected terminal missing. switched back to tfclaw.");
        return;
      }
      this.relay.command({
        command: "terminal.input",
        terminalId: selected.terminalId,
        data: "__CTRL_C__",
      });
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, ".ctrlc sent");
      return;
    }

    if (lower === ".ctrld") {
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        this.setMode(selectionKey, "tfclaw");
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "selected terminal missing. switched back to tfclaw.");
        return;
      }
      this.relay.command({
        command: "terminal.input",
        terminalId: selected.terminalId,
        data: "__CTRL_D__",
      });
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, ".ctrld sent");
      return;
    }

    if (lower === "/key" || lower.startsWith("/key ") || lower === ".key" || lower.startsWith(".key ")) {
      const keySpec = line.replace(/^([/.]key)\s*/i, "").trim();
      if (!keySpec) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.keyUsageText("/key"));
        return;
      }
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        this.setMode(selectionKey, "tfclaw");
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "selected terminal missing. switched back to tfclaw.");
        return;
      }
      await this.sendKeyToTerminal(ctx, selectionKey, selected, keySpec, "/key");
      return;
    }

    if (lower === ".tf" || lower.startsWith(".tf ") || lower === "/tf" || lower.startsWith("/tf ")) {
      const tfclawLine = line.replace(/^(\.tf|\/tf)\s*/i, "").trim();
      if (!tfclawLine) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          "usage: .tf <command>\nexample: .tf list, .tf capture, .tf use terminal-1",
        );
        return;
      }
      const { cmd, args } = this.parseCommandLine(tfclawLine);
      const handled = await this.handleTfclawCommand(ctx, selectionKey, cmd, args);
      if (handled) {
        return;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        `unknown tfclaw command: ${tfclawLine}\nuse .tf help`,
      );
      return;
    }

    const selected = this.selectedTerminal(selectionKey, true);
    if (!selected) {
      this.setMode(selectionKey, "tfclaw");
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "selected terminal is unavailable. switched back to tfclaw mode.",
      );
      return;
    }

    const lineToSend = originalText.replace(/\r/g, "").replace(/\n/g, "");
    this.relay.command({
      command: "terminal.input",
      terminalId: selected.terminalId,
      data: `${lineToSend}\n`,
    });
    const rendered = await this.collectCommandOutput(selected.terminalId);
    await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `# ${selected.title}\n${rendered}`);
    const baseline = this.relay.cache.snapshots.get(selected.terminalId)?.output ?? "";
    this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, selected.terminalId, baseline);
  }

  private async handleCaptureSelection(
    selectionKey: string,
    chatId: string,
    line: string,
    responder: MessageResponder,
  ): Promise<boolean> {
    const key = selectionKey;
    const selection = this.chatCaptureSelections.get(key);
    if (!selection) {
      return false;
    }

    const age = Date.now() - selection.createdAt;
    if (age > 2 * 60 * 1000) {
      this.chatCaptureSelections.delete(key);
      await this.replyWithMode(chatId, responder, key, "capture selection expired. send /tfcapture again.");
      return true;
    }

    if (!/^\d+$/.test(line)) {
      return false;
    }

    const index = Number.parseInt(line, 10) - 1;
    if (index < 0 || index >= selection.options.length) {
      await this.replyWithMode(chatId, responder, key, `invalid number: ${line}. choose 1-${selection.options.length}.`);
      return true;
    }

    const chosen = selection.options[index];
    this.chatCaptureSelections.delete(key);

    const requestId = this.relay.command({
      command: "screen.capture",
      source: chosen.source,
      sourceId: chosen.sourceId,
      terminalId: selection.terminalId,
    });

    const capturePromise = this.relay.waitForCapture(requestId, 20000);
    await this.replyWithMode(chatId, responder, key, `capturing [${chosen.source}] ${chosen.label} ...`);

    try {
      const capture = await capturePromise;
      await responder.replyImage(chatId, capture.imageBase64);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.replyWithMode(chatId, responder, key, `capture failed: ${msg}`);
    }

    return true;
  }

  private async handleCaptureList(selectionKey: string, chatId: string, responder: MessageResponder): Promise<void> {
    const requestId = this.relay.command({
      command: "capture.list",
    });

    let sources: CaptureSource[];
    try {
      sources = await this.relay.waitForCaptureSources(requestId, 15000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.replyWithMode(chatId, responder, selectionKey, `failed to list capture sources: ${msg}`);
      return;
    }

    if (sources.length === 0) {
      await this.replyWithMode(chatId, responder, selectionKey, "no capture sources found.");
      return;
    }

    const key = selectionKey;
    this.chatCaptureSelections.set(key, {
      options: sources,
      terminalId: this.chatTerminalSelection.get(key),
      createdAt: Date.now(),
    });

    await this.replyWithMode(chatId, responder, key, this.formatCaptureOptions(sources));
  }

  private async executeTfclawCommandRequest(
    ctx: InboundTextContext,
    selectionKey: string,
    outboundText: string,
    tmuxSessionKey: string,
  ): Promise<void> {
    const requestId = this.relay.command({
      command: "tfclaw.command",
      text: outboundText,
      sessionKey: tmuxSessionKey,
    });
    this.beginCommandProgressSession(selectionKey, requestId, ctx.chatId, ctx.responder);

    try {
      const output = await this.relay.waitForCommandResult(
        requestId,
        COMMAND_RESULT_TIMEOUT_MS,
        (progressOutput, progressSource) => {
          const source = (progressSource ?? "").trim().toLowerCase();
          if (source && source !== "tmux") {
            return;
          }
          const reply = this.normalizeLegacyErrorMessage(progressOutput);
          if (!reply) {
            return;
          }
          this.queueCommandProgressUpdate(requestId, reply);
        },
      );
      this.updateModeFromResult(selectionKey, outboundText, output);
      const reply = this.normalizeLegacyErrorMessage(output);
      if (!reply) {
        await this.replyWithModeReplacingCommandProgress(requestId, ctx.chatId, ctx.responder, selectionKey, "(no output)");
        return;
      }
      await this.replyWithModeReplacingCommandProgress(requestId, ctx.chatId, ctx.responder, selectionKey, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.replyWithModeReplacingCommandProgress(
        requestId,
        ctx.chatId,
        ctx.responder,
        selectionKey,
        `command failed: ${message}`,
      );
    } finally {
      this.stopCommandProgressSession(requestId, false);
    }
  }

  private async routeToNexChatBot(
    ctx: InboundTextContext,
    selectionKey: string,
    options?: { text?: string; historySeed?: HistorySeedEntry[] },
  ): Promise<void> {
    if (!this.nexChatBridge.enabled) {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        formatGatewayErrorFeedback("nexchatbot", "nexchatbot bridge is disabled"),
      );
      return;
    }

    try {
      const text = (options?.text ?? ctx.llmText ?? ctx.text).trim();
      const reply = await this.nexChatBridge.run({
        source: "tfclaw_feishu_gateway",
        channel: ctx.channel,
        selectionKey,
        chatId: ctx.chatId,
        senderId: ctx.senderId,
        senderOpenId: ctx.senderOpenId,
        senderUserId: ctx.senderUserId,
        messageId: ctx.messageId,
        eventId: ctx.eventId,
        messageType: ctx.messageType,
        text,
        contentRaw: ctx.contentRaw,
        contentObj: ctx.contentObj,
        feishuEvent: ctx.rawEvent,
        historySeed: options?.historySeed,
      });
      await ctx.responder.replyText(ctx.chatId, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[gateway] nexchatbot bridge failed: ${message}`);
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        formatGatewayErrorFeedback("nexchatbot", error),
      );
    }
  }

  private chunkOpenClawReplyText(text: string): string[] {
    const normalized = text.replace(/\r/g, "");
    if (!normalized.trim()) {
      return [];
    }
    if (normalized.length <= FEISHU_TEXT_CHUNK_LIMIT) {
      return [normalized];
    }
    const chunks: string[] = [];
    let rest = normalized;
    while (rest.length > FEISHU_TEXT_CHUNK_LIMIT) {
      const window = rest.slice(0, FEISHU_TEXT_CHUNK_LIMIT);
      const paragraphBreak = window.lastIndexOf("\n\n");
      const newlineBreak = window.lastIndexOf("\n");
      const wordBreak = window.lastIndexOf(" ");
      let breakIndex = Math.max(paragraphBreak, newlineBreak, wordBreak);
      if (breakIndex <= 0 || breakIndex < Math.floor(FEISHU_TEXT_CHUNK_LIMIT * 0.45)) {
        breakIndex = FEISHU_TEXT_CHUNK_LIMIT;
      }
      const chunk = rest.slice(0, breakIndex).trimEnd();
      if (chunk) {
        chunks.push(chunk);
      }
      rest = rest.slice(breakIndex).trimStart();
      if (!rest) {
        break;
      }
    }
    if (rest.trim()) {
      chunks.push(rest);
    }
    return chunks;
  }

  private async routeToOpenClaw(
    ctx: InboundTextContext,
    selectionKey: string,
    options?: {
      text?: string;
      historySeed?: HistorySeedEntry[];
      routingUserKey?: string;
      workspaceOverrideDir?: string;
      modeLabel?: string;
      modeKind?: "user" | "group";
      silent?: boolean;
    },
  ): Promise<void> {
    if (!this.openclawBridge.enabled) {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        formatGatewayErrorFeedback("openclaw", "openclaw bridge is disabled"),
      );
      return;
    }

    const openclawModeTag = this.openclawModeTag(selectionKey);
    try {
      const text = (options?.text ?? ctx.llmText ?? ctx.text).trim();
      const textWithVoiceDirective = `${text}${this.buildVoiceSkillDirective(text)}`.trim();
      // Align external Feishu delivery with upstream OpenClaw guidance:
      // external messaging surfaces should receive only final replies, not
      // partial/streaming deltas. Keep the responder methods available for
      // other gateway features, but do not stream OpenClaw chat deltas here.
      const supportsStreamingCard = false;
      const voiceReplyRequested = this.hasVoiceReplyIntent(ctx.text);
      let streamedByDelta = false;
      let streamedModePrefixed = false;
      const eventMessage = toObject(ctx.rawEvent.message);
      const rawThreadId = toString(eventMessage.thread_id).trim();
      const rawRootId = toString(eventMessage.root_id).trim();
      const rawParentId = toString(eventMessage.parent_id).trim();
      const rawCreateTime = toString(eventMessage.create_time).trim();
      const messageThreadId = rawThreadId || rawRootId || undefined;
      const replyToId = rawParentId || undefined;
      const rootMessageId = rawRootId || undefined;
      const timestamp = /^\d+$/.test(rawCreateTime)
        ? Number.parseInt(rawCreateTime, 10)
        : undefined;
      const reply = await this.openclawBridge.run({
        source: "tfclaw_feishu_gateway",
        channel: ctx.channel,
        selectionKey,
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        isMentioned: ctx.isMentioned,
        hasAnyMention: ctx.hasAnyMention,
        botOpenId: ctx.botOpenId,
        senderId: ctx.senderId,
        senderOpenId: ctx.senderOpenId,
        senderUserId: ctx.senderUserId,
        senderName: ctx.senderName,
        messageId: ctx.messageId,
        eventId: ctx.eventId,
        messageType: ctx.messageType,
        contentRaw: ctx.contentRaw,
        contentObj: ctx.contentObj,
        feishuEvent: ctx.rawEvent,
        messageThreadId,
        replyToId,
        rootMessageId,
        timestamp,
        text: textWithVoiceDirective,
        historySeed: options?.historySeed,
        attachments: ctx.attachments,
        routingUserKey: options?.routingUserKey,
        requesterSenderId: ctx.senderOpenId || ctx.senderId,
        workspaceOverrideDir: options?.workspaceOverrideDir,
        allowEmptyMediaPlaceholderFallback: true,
      }, supportsStreamingCard
        ? {
            onDeltaText: async (deltaText: string): Promise<void> => {
              const normalizedDelta = deltaText.trim();
              if (!normalizedDelta) {
                return;
              }
              if (!streamedByDelta) {
                await ctx.responder.startStreamingCard!(ctx.chatId);
                streamedByDelta = true;
              }
              if (!streamedModePrefixed) {
                streamedModePrefixed = true;
                await ctx.responder.updateStreamingCard!(
                  ctx.chatId,
                  `[mode] ${openclawModeTag}\n${normalizedDelta}`,
                );
                return;
              }
              await ctx.responder.updateStreamingCard!(ctx.chatId, normalizedDelta);
            },
          }
        : undefined);
      if (options?.silent) {
        return;
      }
      const normalizedText = reply.text.trim();
      if (supportsStreamingCard && streamedByDelta) {
        await ctx.responder.finishStreamingCard!(ctx.chatId, normalizedText || undefined);
      } else if (normalizedText) {
        const chunks = this.chunkOpenClawReplyText(normalizedText);
        if (chunks.length > 0) {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, chunks[0] ?? "", {
            modeTagOverride: openclawModeTag,
          });
        }
        for (const chunk of chunks.slice(1)) {
          await ctx.responder.replyText(ctx.chatId, chunk);
        }
      }

      if (!normalizedText && reply.media.length > 0) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "", {
          modeTagOverride: openclawModeTag,
        });
      }

      const allowVoiceBubble = Boolean(reply.audioAsVoice || voiceReplyRequested);
      for (const media of reply.media) {
        const mediaBase64 = media.contentBase64.trim();
        if (!mediaBase64) {
          continue;
        }
        const decoded = Buffer.from(mediaBase64, "base64");
        if (decoded.byteLength === 0) {
          continue;
        }

        const normalizedMimeType = (media.mimeType || "").trim().toLowerCase();
        const imageByExt = /\.(?:jpg|jpeg|png|gif|webp|bmp|ico|tiff)$/i.test(media.fileName || "");
        const audioByExt = /\.(?:mp3|wav|ogg|opus|m4a|aac|flac|amr)$/i.test(media.fileName || "");
        const shouldSendAsImage = (
          media.kind === "image"
          || normalizedMimeType.startsWith("image/")
          || imageByExt
        ) && decoded.byteLength <= FEISHU_MAX_IMAGE_BYTES;
        if (shouldSendAsImage) {
          await ctx.responder.replyImage(ctx.chatId, mediaBase64);
          continue;
        }

        const isAudioMedia = normalizedMimeType.startsWith("audio/") || audioByExt;
        const shouldSendAsAudio = allowVoiceBubble && isAudioMedia;
        if (shouldSendAsAudio && typeof ctx.responder.replyAudio === "function") {
          await ctx.responder.replyAudio(
            ctx.chatId,
            mediaBase64,
            media.fileName || `openclaw-${Date.now()}.opus`,
            media.mimeType,
          );
          continue;
        }

        if (typeof ctx.responder.replyFile === "function") {
          await ctx.responder.replyFile(
            ctx.chatId,
            mediaBase64,
            media.fileName || `openclaw-${Date.now()}.bin`,
            media.mimeType,
          );
          continue;
        }

        await ctx.responder.replyText(
          ctx.chatId,
          `[openclaw media] ${media.fileName || "attachment"} (${media.mimeType || "application/octet-stream"})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options?.silent) {
        console.warn(`[gateway] openclaw silent ingest failed: ${message}`);
        return;
      }
      const feedbackText = formatGatewayErrorFeedback("openclaw", error);
      console.warn(`[gateway] openclaw bridge failed: ${message}`);
      if (
        ctx.channel === "feishu"
        && typeof ctx.responder.finishStreamingCard === "function"
      ) {
        try {
          await ctx.responder.finishStreamingCard(
            ctx.chatId,
            `[mode] ${openclawModeTag}\n${feedbackText}`,
          );
          return;
        } catch {
          // fallback to normal error reply below
        }
      }
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, feedbackText, {
        modeTagOverride: openclawModeTag,
      });
    }
  }

  private async routeToAgentBridge(
    ctx: InboundTextContext,
    selectionKey: string,
    options?: {
      text?: string;
      historySeed?: HistorySeedEntry[];
      routingUserKey?: string;
      workspaceOverrideDir?: string;
      modeLabel?: string;
    },
  ): Promise<void> {
    if (this.openclawBridge.enabled) {
      await this.routeToOpenClaw(ctx, selectionKey, options);
      return;
    }
    await this.routeToNexChatBot(ctx, selectionKey, options);
  }

  async handleInboundMessage(ctx: InboundTextContext): Promise<void> {
    if (ctx.allowFrom.length > 0 && (!ctx.senderId || !ctx.allowFrom.includes(ctx.senderId))) {
      await ctx.responder.replyText(ctx.chatId, formatGatewayErrorFeedback("access", "not allowed"));
      return;
    }

    const userScope = await this.resolveUserScope(ctx);
    const selectionKey = this.selectionKey(ctx.channel, ctx.chatId, userScope.userKey);
    await this.enqueueInboundMessageBySelection(selectionKey, async () => {
      await this.handleInboundMessageWithScope(ctx, userScope, selectionKey);
    });
  }

  private async handleInboundMessageWithScope(
    ctx: InboundTextContext,
    userScope: RouterUserScope,
    selectionKey: string,
  ): Promise<void> {
    await this.accessManager.registerUserAliases(userScope.userKey, [
      ctx.senderOpenId || "",
      ctx.senderUserId || "",
      ctx.senderId || "",
      ctx.senderName || "",
      userScope.linuxUser || "",
    ]);
    await this.accessManager.registerUserDisplayName(userScope.userKey, ctx.senderName || "");
    for (const mention of ctx.mentions ?? []) {
      const mentionUserKey = (mention.openId || mention.userId || "").trim();
      if (!mentionUserKey) {
        continue;
      }
      await this.accessManager.registerUserAliases(mentionUserKey, [
        mention.name || "",
        mention.openId || "",
        mention.userId || "",
      ]);
      await this.accessManager.registerUserDisplayName(mentionUserKey, mention.name || "");
    }
    this.registerObservedGroupParticipants(ctx, userScope);
    const isGroupChat = this.isGroupChat(ctx);
    const isTmuxMode = this.isTmuxMode(selectionKey);
    let text = ctx.text.replace(/\r/g, "").trim();
    let llmText = (ctx.llmText || text).replace(/\r/g, "").trim();
    const commandText = this.normalizeCommandInputText(text);
    const commandLlmText = this.normalizeCommandInputText(llmText);
    const effectiveText = commandText || text;
    const effectiveLlmText = commandLlmText || llmText;

    const allowGroupMessageWithoutMention = this.hasPendingCaptureSelection(selectionKey)
      && /^\d+$/.test(effectiveText);

    if (isGroupChat && !ctx.isMentioned && !allowGroupMessageWithoutMention) {
      const incoming = (llmText || text).trim();
      const incomingForCommandCheck = this.normalizeCommandInputText(incoming);
      if (this.isTfclawManagedSlashCommand(incomingForCommandCheck)) {
        if (FEISHU_DEBUG_INBOUND) {
          console.log(
            `[gateway] group message skipped for silent fanout (tfclaw command without mention): chat_id=${ctx.chatId} sender=${userScope.userKey} text=${JSON.stringify(incomingForCommandCheck.slice(0, 160))}`,
          );
        }
        return;
      }
      if (FEISHU_DEBUG_INBOUND) {
        console.log(
          `[gateway] group message fanout ingest (not mentioned): chat_id=${ctx.chatId} sender=${userScope.userKey} mode=${isTmuxMode ? "tmux" : "tfclaw"} text=${JSON.stringify(incoming.slice(0, 160))}`,
        );
      }
      if (incoming) {
        void this.ingestSilentGroupMessageToOpenClawContexts(ctx, userScope, incoming).catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[gateway] failed to fanout silent group message: ${msg}`);
        });
      }
      return;
    }

    if (isTmuxMode && ctx.messageType !== "text") {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        `tmux mode only accepts text. current message_type=${ctx.messageType || "unknown"}`,
      );
      return;
    }

    if (ctx.messageType !== "text") {
      const routeScope = await this.resolveOpenClawRouteScope(selectionKey, userScope, ctx);
      await this.routeToAgentBridge(
        ctx,
        selectionKey,
        this.toAgentRouteOptions(routeScope),
      );
      return;
    }

    if (!effectiveText) {
      if (!isGroupChat || !ctx.isMentioned) {
        return;
      }
      const fallbackText = (effectiveLlmText || "").trim();
      if (!fallbackText) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          "我收到了 @，但没有识别到具体指令。请直接发送要执行的任务。",
        );
        return;
      }
      await this.routeToAgentBridge(
        {
          ...ctx,
          text: fallbackText,
          llmText: fallbackText,
        },
        selectionKey,
        {
          text: fallbackText,
          ...this.toAgentRouteOptions(await this.resolveOpenClawRouteScope(selectionKey, userScope, ctx)),
        },
      );
      return;
    }

    const accessCommandConsumed = await this.handleAccessControlCommand(ctx, selectionKey, userScope, effectiveText);
    if (accessCommandConsumed) {
      return;
    }

    const captureSelectionConsumed = await this.handleCaptureSelection(
      selectionKey,
      ctx.chatId,
      effectiveText,
      ctx.responder,
    );
    if (captureSelectionConsumed) {
      return;
    }

    const lowered = effectiveText.toLowerCase();
    if (lowered === "/tfcapture" || lowered === "capture") {
      await this.handleCaptureList(selectionKey, ctx.chatId, ctx.responder);
      return;
    }

    if (!isTmuxMode && !this.isTfclawPresetCommand(effectiveText, selectionKey)) {
      const nexchatText = (effectiveLlmText || effectiveText).trim();
      await this.routeToAgentBridge(
        {
          ...ctx,
          text: nexchatText,
          llmText: nexchatText,
        },
        selectionKey,
        {
          text: nexchatText,
          ...this.toAgentRouteOptions(await this.resolveOpenClawRouteScope(selectionKey, userScope, ctx)),
        },
      );
      return;
    }

    const isSlashCommand = effectiveText.startsWith("/");
    const isDotControl = effectiveText.startsWith(".");
    const outboundTextRaw = isTmuxMode && !isSlashCommand && !isDotControl ? `/tmux send ${effectiveText}` : effectiveText;
    const outboundText = this.rewriteTfclawSlashCommandToLegacy(outboundTextRaw);
    await this.executeTfclawCommandRequest(ctx, selectionKey, outboundText, userScope.tmuxSessionKey);
  }
}
// SECTION: chat apps
class FeishuChatApp implements ChatApp, MessageResponder {
  readonly name = "feishu";
  readonly enabled: boolean;
  private wsClient: Lark.WSClient | undefined;
  private larkClient: Lark.Client | undefined;
  private botOpenId = "";
  private botName = "";
  private readonly recentInboundKeys = new Map<string, number>();
  private readonly inboundDedupTtlMs = 5 * 60 * 1000;
  private readonly userNameCache = new Map<string, { name: string; expiresAt: number }>();
  private readonly chatInfoCache = new Map<string, { displayName: string; userCount: number; expiresAt: number }>();
  private readonly systemSenderNameCache = new Map<string, { senderOpenId: string; displayName: string; expiresAt: number }>();
  private readonly ownerDisplayNameByOpenId = new Map<string, string>();
  private ownerDisplayNameIndexExpiresAt = 0;
  private readonly userNameCacheHitTtlMs = 24 * 60 * 60 * 1000;
  private readonly userNameCacheMissTtlMs = 5 * 60 * 1000;
  private readonly chatInfoCacheTtlMs = 10 * 60 * 1000;
  private readonly ownerDisplayNameIndexTtlMs = 10 * 60 * 1000;
  private readonly systemSenderNameCacheTtlMs = 10 * 60 * 1000;

  constructor(
    private readonly config: FeishuChannelConfig,
    private readonly router: TfclawCommandRouter,
  ) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (!this.config.appId || !this.config.appSecret) {
      console.error("[gateway] feishu enabled but appId/appSecret missing.");
      return;
    }

    if (this.config.disableProxy) {
      mergeNoProxyHosts(this.config.noProxyHosts);
      console.log(`[gateway] feishu no_proxy applied: ${(process.env.NO_PROXY ?? "").trim()}`);
    }

    this.larkClient = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
    await this.initBotIdentity();

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({
        encryptKey: this.config.encryptKey,
        verificationToken: this.config.verificationToken,
      }).register({
        "im.message.receive_v1": async (data: unknown) => {
          await this.handleInboundEvent(data);
        },
      }),
    });

    console.log("[gateway] feishu connected via Long Connection");
  }

  async close(): Promise<void> {
    const wsAny = this.wsClient as { stop?: () => void; close?: () => void } | undefined;
    try {
      wsAny?.stop?.();
    } catch {
      // no-op
    }
    try {
      wsAny?.close?.();
    } catch {
      // no-op
    }
    this.wsClient = undefined;
  }

  private async parseJsonResponse(response: { text: () => Promise<string> }): Promise<Record<string, unknown>> {
    const raw = await response.text();
    if (!raw) {
      return {};
    }
    try {
      return toObject(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  private async initBotIdentity(): Promise<void> {
    const envOpenId = toString(process.env.BOT_OPEN_ID).trim();
    const envName = toString(process.env.BOT_NAME).trim();
    if (envOpenId) {
      this.botOpenId = envOpenId;
    }
    if (envName) {
      this.botName = envName;
    }

    try {
      const authResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });
      const authPayload = await this.parseJsonResponse(authResponse);
      if (!authResponse.ok || toNumber(authPayload.code, -1) !== 0) {
        throw new Error(`auth failed: code=${toString(authPayload.code, "unknown")} msg=${toString(authPayload.msg, "")}`);
      }
      const tenantToken = toString(authPayload.tenant_access_token).trim();
      if (!tenantToken) {
        throw new Error("tenant_access_token is empty");
      }

      const botResponse = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
        method: "GET",
        headers: {
          authorization: `Bearer ${tenantToken}`,
        },
      });
      const botPayload = await this.parseJsonResponse(botResponse);
      if (!botResponse.ok || toNumber(botPayload.code, -1) !== 0) {
        throw new Error(`bot info failed: code=${toString(botPayload.code, "unknown")} msg=${toString(botPayload.msg, "")}`);
      }
      const botObj = toObject(botPayload.bot);
      const openId = toString(botObj.open_id).trim();
      const name = toString(botObj.app_name, toString(botObj.name)).trim();
      if (openId) {
        this.botOpenId = openId;
      }
      if (name) {
        this.botName = name;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[gateway] failed to init bot identity via api: ${msg}`);
    }

    if (this.botOpenId || this.botName) {
      console.log(`[gateway] bot identity: open_id=${this.botOpenId || "unknown"} name=${this.botName || "unknown"}`);
    } else {
      console.warn("[gateway] bot identity unavailable, group mention detection may be less accurate");
    }
  }

  private isOtherBotSender(senderUserId: string, senderOpenId: string): boolean {
    const userId = senderUserId.trim();
    const openId = senderOpenId.trim();
    if (!userId && !openId) {
      return false;
    }
    if (this.botOpenId && (userId === this.botOpenId || openId === this.botOpenId)) {
      return false;
    }
    if (userId === this.config.appId || openId === this.config.appId) {
      return false;
    }
    if (userId.startsWith("cli_") || openId.startsWith("cli_")) {
      return true;
    }
    return false;
  }

  private isDuplicateInbound(key: string): boolean {
    const now = Date.now();
    for (const [storedKey, seenAt] of this.recentInboundKeys.entries()) {
      if (now - seenAt > this.inboundDedupTtlMs) {
        this.recentInboundKeys.delete(storedKey);
      }
    }
    if (this.recentInboundKeys.has(key)) {
      return true;
    }
    this.recentInboundKeys.set(key, now);
    return false;
  }

  private looksLikeFeishuIdentifier(value: string): boolean {
    return /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(value.trim());
  }

  private looksLikeLinuxUser(value: string): boolean {
    return /^tfoc_[a-f0-9]+$/i.test(value.trim());
  }

  private normalizeDisplayNameCandidate(value: string): string {
    return value.trim().replace(/\s+/g, " ");
  }

  private isLikelyHumanName(value: string): boolean {
    const normalized = this.normalizeDisplayNameCandidate(value);
    if (!normalized) {
      return false;
    }
    if (this.looksLikeFeishuIdentifier(normalized) || this.looksLikeLinuxUser(normalized)) {
      return false;
    }
    if (/\p{Script=Han}/u.test(normalized)) {
      return true;
    }
    if (/^[A-Za-z][A-Za-z '.-]{0,39}$/.test(normalized)) {
      return true;
    }
    return false;
  }

  private selectLikelyHumanName(...values: string[]): string {
    for (const value of values) {
      const normalized = this.normalizeDisplayNameCandidate(value);
      if (!this.isLikelyHumanName(normalized)) {
        continue;
      }
      return normalized;
    }
    return "";
  }

  private selectDisplayNameCandidate(...values: string[]): string {
    for (const value of values) {
      const normalized = this.normalizeDisplayNameCandidate(value);
      if (!normalized) {
        continue;
      }
      if (this.looksLikeFeishuIdentifier(normalized) || this.looksLikeLinuxUser(normalized)) {
        continue;
      }
      return normalized;
    }
    return "";
  }

  private getCachedUserDisplayName(cacheKey: string): string | undefined {
    const hit = this.userNameCache.get(cacheKey);
    if (!hit) {
      return undefined;
    }
    if (Date.now() > hit.expiresAt) {
      this.userNameCache.delete(cacheKey);
      return undefined;
    }
    if (!hit.name) {
      this.userNameCache.delete(cacheKey);
      return undefined;
    }
    return hit.name;
  }

  private setCachedUserDisplayName(cacheKey: string, name: string): void {
    const normalized = this.normalizeDisplayNameCandidate(name);
    this.userNameCache.set(cacheKey, {
      name: normalized,
      expiresAt: Date.now() + (normalized ? this.userNameCacheHitTtlMs : this.userNameCacheMissTtlMs),
    });
  }

  private extractUserNameFromContactResponse(response: unknown): string {
    const obj = toObject(response);
    const dataObj = toObject(obj.data);
    const userObj = toObject(dataObj.user);
    return this.selectDisplayNameCandidate(
      toString(userObj.name),
      toString(userObj.en_name),
      toString(userObj.nickname),
      toString(userObj.employee_name),
    );
  }

  private getCachedChatInfo(chatId: string): { displayName: string; userCount: number } | undefined {
    const hit = this.chatInfoCache.get(chatId);
    if (!hit) {
      return undefined;
    }
    if (Date.now() > hit.expiresAt) {
      this.chatInfoCache.delete(chatId);
      return undefined;
    }
    return {
      displayName: hit.displayName,
      userCount: hit.userCount,
    };
  }

  private async fetchChatInfo(chatId: string): Promise<{ displayName: string; userCount: number } | undefined> {
    const normalizedChatId = chatId.trim();
    if (!this.larkClient || !normalizedChatId) {
      return undefined;
    }
    const cached = this.getCachedChatInfo(normalizedChatId);
    if (cached) {
      return cached;
    }
    try {
      const response = await this.larkClient.im.v1.chat.get({
        path: {
          chat_id: normalizedChatId,
        },
        params: {
          user_id_type: "open_id",
        },
      });
      const obj = toObject(response);
      const dataObj = toObject(obj.data);
      const i18nObj = toObject(dataObj.i18n_names);
      const displayName = this.selectLikelyHumanName(
        toString(dataObj.name),
        toString(i18nObj.zh_cn),
        toString(i18nObj.en_us),
      );
      const userCount = Math.max(0, toNumber(dataObj.user_count, 0));
      this.chatInfoCache.set(normalizedChatId, {
        displayName,
        userCount,
        expiresAt: Date.now() + this.chatInfoCacheTtlMs,
      });
      return {
        displayName,
        userCount,
      };
    } catch {
      return undefined;
    }
  }

  private async fetchUserDisplayNameById(
    idValue: string,
    idType: "open_id" | "user_id",
  ): Promise<string> {
    const normalizedId = idValue.trim();
    if (!this.larkClient || !normalizedId) {
      return "";
    }
    const cacheKey = `${idType}:${normalizedId}`;
    const cached = this.getCachedUserDisplayName(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const response = await this.larkClient.contact.v3.user.get({
        path: {
          user_id: normalizedId,
        },
        params: {
          user_id_type: idType,
        },
      });
      const name = this.extractUserNameFromContactResponse(response);
      if (!name && FEISHU_DEBUG_INBOUND) {
        const obj = toObject(response);
        const userObj = toObject(toObject(obj.data).user);
        const userKeys = Object.keys(userObj).sort().join(",");
        console.warn(`[gateway] feishu contact user has no name fields: ${cacheKey} keys=[${userKeys}]`);
      }
      this.setCachedUserDisplayName(cacheKey, name);
      return name;
    } catch (error) {
      this.setCachedUserDisplayName(cacheKey, "");
      if (FEISHU_DEBUG_INBOUND) {
        console.warn(`[gateway] feishu fetch user profile failed: ${describeSdkError(error)} | ${cacheKey}`);
      }
      return "";
    }
  }

  private async refreshOwnerDisplayNameIndex(): Promise<void> {
    const now = Date.now();
    if (!this.larkClient || now < this.ownerDisplayNameIndexExpiresAt) {
      return;
    }
    const next = new Map<string, string>();
    let pageToken = "";
    for (let i = 0; i < 20; i += 1) {
      const response = await this.larkClient.im.v1.chat.list({
        params: {
          page_size: 50,
          user_id_type: "open_id",
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const obj = toObject(response);
      if (obj.code !== undefined && toNumber(obj.code, 0) !== 0) {
        break;
      }
      const dataObj = toObject(obj.data);
      const items = Array.isArray(dataObj.items) ? dataObj.items : [];
      for (const rawItem of items) {
        const item = toObject(rawItem);
        const ownerOpenId = toString(item.owner_id).trim();
        if (!ownerOpenId) {
          continue;
        }
        const i18n = toObject(item.i18n_names);
        const displayName = this.selectLikelyHumanName(
          toString(item.name),
          toString(i18n.zh_cn),
          toString(i18n.en_us),
        );
        if (!displayName) {
          continue;
        }
        if (this.botName && displayName.trim().toLowerCase() === this.botName.trim().toLowerCase()) {
          continue;
        }
        if (/[，,]/.test(displayName)) {
          continue;
        }
        if (/bot/i.test(displayName) && !/\p{Script=Han}/u.test(displayName)) {
          continue;
        }
        const previous = next.get(ownerOpenId);
        if (!previous || displayName.length < previous.length) {
          next.set(ownerOpenId, displayName);
        }
      }
      if (!Boolean(dataObj.has_more)) {
        break;
      }
      pageToken = toString(dataObj.page_token).trim();
      if (!pageToken) {
        break;
      }
    }
    this.ownerDisplayNameByOpenId.clear();
    for (const [key, value] of next.entries()) {
      this.ownerDisplayNameByOpenId.set(key, value);
    }
    this.ownerDisplayNameIndexExpiresAt = now + this.ownerDisplayNameIndexTtlMs;
  }

  private async fetchOwnerDisplayNameByOpenId(openId: string): Promise<string> {
    const normalizedOpenId = openId.trim();
    if (!normalizedOpenId) {
      return "";
    }
    await this.refreshOwnerDisplayNameIndex();
    return this.ownerDisplayNameByOpenId.get(normalizedOpenId) || "";
  }

  private getCachedSystemSenderName(chatId: string, senderOpenId: string): string | undefined {
    const hit = this.systemSenderNameCache.get(chatId);
    if (!hit) {
      return undefined;
    }
    if (Date.now() > hit.expiresAt) {
      this.systemSenderNameCache.delete(chatId);
      return undefined;
    }
    if (hit.senderOpenId !== senderOpenId) {
      return undefined;
    }
    return hit.displayName;
  }

  private async fetchSenderDisplayNameFromSystemMessages(chatId: string, senderOpenId: string): Promise<string> {
    const normalizedChatId = chatId.trim();
    const normalizedSenderOpenId = senderOpenId.trim();
    if (!this.larkClient || !normalizedChatId || !normalizedSenderOpenId) {
      return "";
    }
    const cached = this.getCachedSystemSenderName(normalizedChatId, normalizedSenderOpenId);
    if (cached) {
      return cached;
    }
    try {
      const response = await this.larkClient.im.v1.message.list({
        params: {
          container_id_type: "chat",
          container_id: normalizedChatId,
          page_size: 50,
          sort_type: "ByCreateTimeAsc",
        },
      });
      const obj = toObject(response);
      if (obj.code !== undefined && toNumber(obj.code, 0) !== 0) {
        return "";
      }
      const dataObj = toObject(obj.data);
      const items = Array.isArray(dataObj.items) ? dataObj.items : [];
      const userSenders = new Set<string>();
      const systemNames: string[] = [];
      for (const rawItem of items) {
        const item = toObject(rawItem);
        const senderObj = toObject(item.sender);
        const senderType = toString(senderObj.sender_type).trim().toLowerCase();
        const senderId = toString(senderObj.id).trim();
        if (senderType === "user" && senderId) {
          userSenders.add(senderId);
        }
        const messageType = toString(item.msg_type).trim().toLowerCase();
        if (messageType !== "system") {
          continue;
        }
        const bodyObj = toObject(item.body);
        const contentText = toString(bodyObj.content).trim();
        if (!contentText) {
          continue;
        }
        let contentObj: Record<string, unknown> = {};
        try {
          contentObj = toObject(JSON.parse(contentText));
        } catch {
          contentObj = {};
        }
        const fromUsers = Array.isArray(contentObj.from_user) ? contentObj.from_user : [];
        for (const fromUser of fromUsers) {
          systemNames.push(toString(fromUser));
        }
      }
      if (!(userSenders.size === 1 && userSenders.has(normalizedSenderOpenId))) {
        return "";
      }
      const displayName = this.selectLikelyHumanName(...systemNames);
      if (!displayName) {
        return "";
      }
      this.systemSenderNameCache.set(normalizedChatId, {
        senderOpenId: normalizedSenderOpenId,
        displayName,
        expiresAt: Date.now() + this.systemSenderNameCacheTtlMs,
      });
      return displayName;
    } catch {
      return "";
    }
  }

  private async resolveSenderDisplayName(
    senderObj: Record<string, unknown>,
    senderOpenId: string,
    senderUserId: string,
    contentObj: Record<string, unknown>,
    chatId: string,
    chatType: string,
  ): Promise<string> {
    const fromPayload = this.selectDisplayNameCandidate(
      toString(senderObj.name),
      toString(senderObj.sender_name),
      toString(senderObj.user_name),
      toString(senderObj.nickname),
      toString(senderObj.display_name),
      toString(toObject(senderObj.sender).name),
      toString(toObject(toObject(senderObj.sender).sender).name),
      toString(contentObj.user_name),
      toString(contentObj.name),
    );
    if (fromPayload) {
      return fromPayload;
    }
    const fromOpenId = await this.fetchUserDisplayNameById(senderOpenId, "open_id");
    if (fromOpenId) {
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, fromOpenId);
      }
      return fromOpenId;
    }
    const fromUserId = await this.fetchUserDisplayNameById(senderUserId, "user_id");
    if (fromUserId) {
      if (senderOpenId.trim()) {
        this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, fromUserId);
      }
      return fromUserId;
    }
    const fromSystem = await this.fetchSenderDisplayNameFromSystemMessages(chatId, senderOpenId);
    if (fromSystem) {
      this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, fromSystem);
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, fromSystem);
      }
      return fromSystem;
    }
    const chatInfo = await this.fetchChatInfo(chatId);
    const normalizedChatType = chatType.trim().toLowerCase();
    if (chatInfo?.displayName
      && (chatInfo.userCount === 1
        || normalizedChatType === "p2p"
        || normalizedChatType === "single")) {
      if (senderOpenId.trim()) {
        this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, chatInfo.displayName);
      }
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, chatInfo.displayName);
      }
      return chatInfo.displayName;
    }
    const fromOwner = await this.fetchOwnerDisplayNameByOpenId(senderOpenId);
    if (fromOwner) {
      this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, fromOwner);
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, fromOwner);
      }
      return fromOwner;
    }
    console.warn(
      `[gateway] sender name unresolved: chat_id=${chatId} chat_type=${normalizedChatType || "unknown"} sender_open_id=${senderOpenId || "unknown"} sender_user_id=${senderUserId || "unknown"} chat_name=${chatInfo?.displayName || "(none)"} chat_user_count=${chatInfo?.userCount ?? -1}`,
    );
    return "";
  }

  private async sendTextMessage(
    chatId: string,
    text: string,
    options?: {
      replyToMessageId?: string;
      replyInThread?: boolean;
    },
  ): Promise<{ messageId?: string }> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const normalizedText = text.replace(/\r/g, "");
    const replyToMessageId = toString(options?.replyToMessageId).trim();
    const replyInThread = Boolean(options?.replyInThread);
    const payload = this.buildFeishuTextPayload(normalizedText);
    const sendOptions: FeishuSendOptions = {
      replyToMessageId: replyToMessageId || undefined,
      replyInThread,
    };
    try {
      return await this.sendFeishuReplyOrDirectMessage(
        chatId,
        payload.msgType,
        payload.content,
        sendOptions,
      );
    } catch (error) {
      if (payload.msgType === "interactive" && this.isFeishuCardMarkdownParseError(error)) {
        console.warn(
          `[gateway] feishu card render failed, fallback to plain post text: ${describeSdkError(error)}`,
        );
        return this.sendPlainPostTextMessage(chatId, normalizedText, sendOptions);
      }
      throw error;
    }
  }

  private extractFeishuMessageId(result: unknown): string | undefined {
    const resultObj = toObject(result);
    const dataObj = toObject(resultObj.data);
    return toString(dataObj.message_id) || toString(resultObj.message_id) || undefined;
  }

  private resolveFeishuRenderMode(): FeishuRenderMode {
    const mode = this.config.renderMode.trim().toLowerCase();
    if (mode === "raw" || mode === "card") {
      return mode;
    }
    return "auto";
  }

  private shouldUseFeishuCard(text: string): boolean {
    return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
  }

  private buildFeishuPostMessagePayload(text: string): { msgType: "post"; content: string } {
    return {
      msgType: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [
            [
              {
                tag: "md",
                text,
              },
            ],
          ],
        },
      }),
    };
  }

  private buildFeishuPlainPostMessagePayload(text: string): { msgType: "post"; content: string } {
    return {
      msgType: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [
            [
              {
                tag: "text",
                text,
              },
            ],
          ],
        },
      }),
    };
  }

  private buildFeishuMarkdownCardContent(text: string): string {
    return JSON.stringify({
      schema: "2.0",
      config: {
        wide_screen_mode: true,
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: text,
          },
        ],
      },
    });
  }

  private buildFeishuTextPayload(text: string): { msgType: "post" | "interactive"; content: string } {
    const renderMode = this.resolveFeishuRenderMode();
    const useCard = renderMode === "card" || (renderMode === "auto" && this.shouldUseFeishuCard(text));
    if (useCard) {
      return {
        msgType: "interactive",
        content: this.buildFeishuMarkdownCardContent(text),
      };
    }
    return this.buildFeishuPostMessagePayload(text);
  }

  private shouldFallbackFromReplyTarget(response: Record<string, unknown>): boolean {
    const code = response.code;
    if (typeof code === "number" && FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
      return true;
    }
    const msg = toString(response.msg).toLowerCase();
    return msg.includes("withdrawn") || msg.includes("not found");
  }

  private isWithdrawnReplyError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const errObj = error as {
      code?: unknown;
      response?: {
        data?: {
          code?: unknown;
        };
      };
    };
    if (typeof errObj.code === "number" && FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(errObj.code)) {
      return true;
    }
    const nestedCode = errObj.response?.data?.code;
    if (typeof nestedCode === "number" && FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(nestedCode)) {
      return true;
    }
    return false;
  }

  private isFeishuCardMarkdownParseError(error: unknown): boolean {
    const baseMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (
      baseMessage.includes("markdown content parse error")
      || baseMessage.includes("failed to create card content")
      || baseMessage.includes("230099")
    ) {
      return true;
    }
    const errObj = toObject(error);
    if (toNumber(errObj.code, 0) === 230099) {
      return true;
    }
    const responseObj = toObject(errObj.response);
    const dataObj = toObject(responseObj.data);
    if (toNumber(dataObj.code, 0) === 230099) {
      return true;
    }
    const nestedMessage = toString(dataObj.msg).toLowerCase();
    return (
      nestedMessage.includes("markdown content parse error")
      || nestedMessage.includes("failed to create card content")
    );
  }

  private assertFeishuMessageApiSuccess(response: unknown, errorPrefix: string): void {
    const obj = toObject(response);
    const code = obj.code;
    if (typeof code === "number" && code !== 0) {
      const msg = toString(obj.msg) || `code ${code}`;
      throw new Error(`${errorPrefix}: ${msg}`);
    }
  }

  private async fallbackToFeishuDirectMessage(
    chatId: string,
    msgType: FeishuMessageType,
    content: string,
    reason: string,
    sourceMessageId: string,
  ): Promise<{ messageId?: string }> {
    console.warn(
      `[gateway] feishu reply fallback -> direct send: chat_id=${chatId} source_message_id=${sourceMessageId || "unknown"} reason=${reason}`,
    );
    try {
      return await this.sendFeishuDirectMessage(chatId, msgType, content);
    } catch (error) {
      throw new Error(
        `feishu reply failed and direct fallback failed: reply=${reason} | direct=${describeSdkError(error)} | chat_id=${chatId} source_message_id=${sourceMessageId || "unknown"}`,
      );
    }
  }

  private async sendFeishuReplyOrDirectMessage(
    chatId: string,
    msgType: FeishuMessageType,
    content: string,
    options?: FeishuSendOptions,
  ): Promise<{ messageId?: string }> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }
    const replyToMessageId = toString(options?.replyToMessageId).trim();
    if (replyToMessageId) {
      try {
        const replyResult = await this.larkClient.im.v1.message.reply({
          path: {
            message_id: replyToMessageId,
          },
          data: {
            msg_type: msgType,
            content,
            ...(options?.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        const replyObj = toObject(replyResult);
        if (this.shouldFallbackFromReplyTarget(replyObj)) {
          return this.sendFeishuDirectMessage(chatId, msgType, content);
        }
        const replyCode = replyObj.code;
        if (typeof replyCode === "number" && replyCode !== 0) {
          const replyMsg = toString(replyObj.msg) || `code ${replyCode}`;
          return await this.fallbackToFeishuDirectMessage(
            chatId,
            msgType,
            content,
            `api code=${replyCode} msg=${replyMsg}`,
            replyToMessageId,
          );
        }
        return {
          messageId: this.extractFeishuMessageId(replyResult),
        };
      } catch (error) {
        if (this.isWithdrawnReplyError(error)) {
          return this.sendFeishuDirectMessage(chatId, msgType, content);
        }
        return await this.fallbackToFeishuDirectMessage(
          chatId,
          msgType,
          content,
          describeSdkError(error),
          replyToMessageId,
        );
      }
    }
    return this.sendFeishuDirectMessage(chatId, msgType, content);
  }

  private async sendFeishuDirectMessage(
    chatId: string,
    msgType: FeishuMessageType,
    content: string,
  ): Promise<{ messageId?: string }> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }
    const result = await this.larkClient.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content,
      },
    });
    this.assertFeishuMessageApiSuccess(result, "feishu send failed");
    return {
      messageId: this.extractFeishuMessageId(result),
    };
  }

  private async sendPlainPostTextMessage(
    chatId: string,
    text: string,
    options?: FeishuSendOptions,
  ): Promise<{ messageId?: string }> {
    const normalizedText = text.replace(/\r/g, "");
    const payload = this.buildFeishuPlainPostMessagePayload(normalizedText);
    return this.sendFeishuReplyOrDirectMessage(chatId, payload.msgType, payload.content, options);
  }

  private mergeStreamingText(previousText: string | undefined, nextText: string | undefined): string {
    const previous = typeof previousText === "string" ? previousText : "";
    const next = typeof nextText === "string" ? nextText : "";
    if (!next) {
      return previous;
    }
    if (!previous || next === previous) {
      return next;
    }
    if (next.startsWith(previous)) {
      return next;
    }
    if (previous.startsWith(next)) {
      return previous;
    }
    if (next.includes(previous)) {
      return next;
    }
    if (previous.includes(next)) {
      return previous;
    }
    const maxOverlap = Math.min(previous.length, next.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      if (previous.slice(-overlap) === next.slice(0, overlap)) {
        return `${previous}${next.slice(overlap)}`;
      }
    }
    return `${previous}${next}`;
  }

  private async patchFeishuCardMessage(messageId: string, text: string): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }
    const response = await this.larkClient.im.v1.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: this.buildFeishuMarkdownCardContent(text),
      },
    });
    this.assertFeishuMessageApiSuccess(response, "feishu streaming card update failed");
  }

  async replyText(chatId: string, text: string): Promise<void> {
    await this.sendTextMessage(chatId, text);
  }

  async replyTextWithMeta(chatId: string, text: string): Promise<{ messageId?: string }> {
    return this.sendTextMessage(chatId, text);
  }

  private buildInboundResponder(
    sourceMessageId?: string,
    options?: {
      replyInThread?: boolean;
    },
  ): MessageResponder {
    const replyOptions: FeishuSendOptions = {
      replyToMessageId: sourceMessageId,
      replyInThread: Boolean(options?.replyInThread),
    };
    type StreamingCardState = {
      messageId: string;
      currentText: string;
      pendingText: string | null;
      queue: Promise<void>;
      lastUpdateAt: number;
      closed: boolean;
    };
    let streamingCardState: StreamingCardState | undefined;
    let streamingCardStartPromise: Promise<StreamingCardState> | undefined;
    let streamingCardDegradedToPost = false;
    let streamingCardFallbackText = "";

    const appendStreamingCardFallbackText = (text: string): void => {
      streamingCardFallbackText = this.mergeStreamingText(streamingCardFallbackText, text);
    };

    const flushStreamingCardFallbackToPost = async (
      chatId: string,
      extraText?: string,
    ): Promise<void> => {
      if (extraText) {
        appendStreamingCardFallbackText(extraText);
      }
      const fallbackText = streamingCardFallbackText.trim();
      streamingCardFallbackText = "";
      streamingCardDegradedToPost = false;
      if (!fallbackText) {
        return;
      }
      await this.sendPlainPostTextMessage(chatId, fallbackText, replyOptions);
    };

    const degradeStreamingCardToPost = async (
      state: StreamingCardState,
      text: string,
      error: unknown,
    ): Promise<void> => {
      streamingCardDegradedToPost = true;
      appendStreamingCardFallbackText(text);
      state.pendingText = null;
      state.currentText = this.mergeStreamingText(state.currentText, text);
      state.closed = true;
      streamingCardState = undefined;
      console.warn(
        `[gateway] feishu streaming card markdown parse failed, fallback to post text: ${describeSdkError(error)}`,
      );
      try {
        await this.deleteMessage(state.messageId);
      } catch (deleteError) {
        const detail = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.warn(`[gateway] feishu streaming card cleanup failed: ${detail}`);
      }
    };

    const ensureStreamingCardState = async (chatId: string): Promise<StreamingCardState> => {
      if (streamingCardDegradedToPost) {
        throw new Error("feishu streaming card disabled due to markdown parse fallback");
      }
      if (streamingCardState && !streamingCardState.closed) {
        return streamingCardState;
      }
      if (streamingCardStartPromise) {
        return await streamingCardStartPromise;
      }
      streamingCardStartPromise = (async () => {
        const started = await this.sendFeishuReplyOrDirectMessage(
          chatId,
          "interactive",
          this.buildFeishuMarkdownCardContent("⏳ Thinking..."),
          replyOptions,
        );
        const messageId = toString(started.messageId).trim();
        if (!messageId) {
          throw new Error("feishu streaming card start failed: missing message id");
        }
        streamingCardState = {
          messageId,
          currentText: "",
          pendingText: null,
          queue: Promise.resolve(),
          lastUpdateAt: 0,
          closed: false,
        };
        return streamingCardState;
      })();
      try {
        return await streamingCardStartPromise;
      } finally {
        streamingCardStartPromise = undefined;
      }
    };

    const queueStreamingCardUpdate = async (
      chatId: string,
      text: string,
    ): Promise<void> => {
      const normalized = text.replace(/\r/g, "");
      if (!normalized.trim()) {
        return;
      }
      if (streamingCardDegradedToPost) {
        appendStreamingCardFallbackText(normalized);
        return;
      }
      const state = await ensureStreamingCardState(chatId);
      const mergedInput = this.mergeStreamingText(state.pendingText ?? state.currentText, normalized);
      if (!mergedInput || mergedInput === state.currentText) {
        return;
      }
      const now = Date.now();
      if (now - state.lastUpdateAt < FEISHU_STREAMING_CARD_UPDATE_THROTTLE_MS) {
        state.pendingText = mergedInput;
        return;
      }
      state.pendingText = null;
      state.lastUpdateAt = now;
      state.queue = state.queue.then(async () => {
        if (state.closed) {
          return;
        }
        const mergedText = this.mergeStreamingText(state.currentText, mergedInput);
        if (!mergedText || mergedText === state.currentText) {
          return;
        }
        try {
          await this.patchFeishuCardMessage(state.messageId, mergedText);
          state.currentText = mergedText;
        } catch (error) {
          if (!this.isFeishuCardMarkdownParseError(error)) {
            throw error;
          }
          await degradeStreamingCardToPost(state, mergedText, error);
        }
      });
      await state.queue;
    };

    const finishStreamingCard = async (
      chatId: string,
      finalText?: string,
    ): Promise<void> => {
      const normalizedFinal = toString(finalText).replace(/\r/g, "").trim();
      if (streamingCardDegradedToPost) {
        await flushStreamingCardFallbackToPost(chatId, normalizedFinal || undefined);
        return;
      }
      if (!streamingCardState && streamingCardStartPromise) {
        try {
          await streamingCardStartPromise;
        } catch {
          // start failure handled by fallback path below
        }
      }
      if (!streamingCardState || streamingCardState.closed) {
        if (normalizedFinal) {
          await this.sendTextMessage(chatId, normalizedFinal, replyOptions);
        }
        return;
      }
      const state = streamingCardState;
      await state.queue;
      let targetText = this.mergeStreamingText(state.currentText, state.pendingText ?? undefined);
      if (normalizedFinal) {
        targetText = this.mergeStreamingText(targetText, normalizedFinal);
      }
      if (targetText && targetText !== state.currentText) {
        try {
          await this.patchFeishuCardMessage(state.messageId, targetText);
          state.currentText = targetText;
        } catch (error) {
          if (!this.isFeishuCardMarkdownParseError(error)) {
            throw error;
          }
          await degradeStreamingCardToPost(state, targetText, error);
        }
      }
      if (streamingCardDegradedToPost) {
        await flushStreamingCardFallbackToPost(chatId);
        return;
      }
      state.closed = true;
      streamingCardState = undefined;
    };

    return {
      replyText: async (chatId: string, text: string): Promise<void> => {
        await this.sendTextMessage(chatId, text, replyOptions);
      },
      replyTextWithMeta: async (chatId: string, text: string): Promise<{ messageId?: string }> => {
        return this.sendTextMessage(chatId, text, replyOptions);
      },
      replyImage: async (chatId: string, imageBase64: string): Promise<void> => {
        await this.replyImage(chatId, imageBase64, replyOptions);
      },
      replyAudio: async (chatId: string, audioBase64: string, fileName?: string, mimeType?: string): Promise<void> => {
        await this.replyAudio(chatId, audioBase64, fileName, mimeType, replyOptions);
      },
      replyFile: async (chatId: string, fileBase64: string, fileName: string, mimeType?: string): Promise<void> => {
        await this.replyFile(chatId, fileBase64, fileName, mimeType, replyOptions);
      },
      deleteMessage: async (messageId: string): Promise<void> => {
        await this.deleteMessage(messageId);
      },
      startStreamingCard: async (chatId: string): Promise<void> => {
        await ensureStreamingCardState(chatId);
      },
      updateStreamingCard: async (chatId: string, text: string): Promise<void> => {
        await queueStreamingCardUpdate(chatId, text);
      },
      finishStreamingCard: async (chatId: string, finalText?: string): Promise<void> => {
        await finishStreamingCard(chatId, finalText);
      },
    };
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }
    try {
      await this.larkClient.im.v1.message.delete({
        path: {
          message_id: messageId,
        },
      });
    } catch (error) {
      throw new Error(`feishu message delete failed: ${describeSdkError(error)} | message_id=${messageId}`);
    }
  }

  private async addReaction(messageId: string, emojiType = FEISHU_ACK_REACTION): Promise<void> {
    if (!this.larkClient || !messageId) {
      return;
    }
    await this.larkClient.im.v1.messageReaction.create({
      path: {
        message_id: messageId,
      },
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    });
  }

  private normalizeOutboundMimeType(mimeType?: string): string {
    return toString(mimeType).trim().split(";")[0]?.trim().toLowerCase() || "";
  }

  private detectFeishuUploadFileType(
    fileName: string,
    mimeType?: string,
  ): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
    const ext = path.extname(fileName).trim().toLowerCase();
    switch (ext) {
      case ".opus":
      case ".ogg":
        return "opus";
      case ".mp4":
      case ".mov":
      case ".avi":
      case ".m4v":
      case ".webm":
      case ".mkv":
        return "mp4";
      case ".pdf":
        return "pdf";
      case ".doc":
      case ".docx":
        return "doc";
      case ".xls":
      case ".xlsx":
      case ".csv":
        return "xls";
      case ".ppt":
      case ".pptx":
        return "ppt";
      default: {
        const normalizedMime = this.normalizeOutboundMimeType(mimeType);
        if (
          normalizedMime === "audio/ogg"
          || normalizedMime === "audio/opus"
          || normalizedMime === "audio/opus+ogg"
          || normalizedMime === "application/ogg"
        ) {
          return "opus";
        }
        if (normalizedMime.startsWith("video/")) {
          return "mp4";
        }
        return "stream";
      }
    }
  }

  private resolveFeishuMessageTypeByFileType(fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"): "file" | "audio" | "media" {
    if (fileType === "opus") {
      return "audio";
    }
    if (fileType === "mp4") {
      return "media";
    }
    return "file";
  }

  async replyImage(chatId: string, imageBase64: string, options?: FeishuSendOptions): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const imageBuffer = Buffer.from(imageBase64, "base64");
    if (imageBuffer.byteLength === 0) {
      throw new Error("empty image");
    }
    if (imageBuffer.byteLength > FEISHU_MAX_IMAGE_BYTES) {
      throw new Error("image too large (>10MB)");
    }

    const tmpPath = path.join(
      os.tmpdir(),
      `tfclaw-feishu-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
    );
    fs.writeFileSync(tmpPath, imageBuffer);

    let uploadResult: unknown;
    let imageStream: fs.ReadStream | undefined;
    try {
      imageStream = fs.createReadStream(tmpPath);
      uploadResult = await this.larkClient.im.v1.image.create({
        data: {
          image_type: "message",
          image: imageStream,
        },
      });
    } catch (error) {
      throw new Error(`feishu image upload failed: ${describeSdkError(error)}`);
    } finally {
      try {
        imageStream?.destroy();
      } catch {
        // no-op
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // no-op
      }
    }

    const uploadObj = toObject(uploadResult);
    const uploadData = toObject(uploadObj.data);
    const imageKey = toString(uploadObj.image_key) || toString(uploadData.image_key);
    if (!imageKey) {
      const code = toString(uploadObj.code);
      const msg = toString(uploadObj.msg);
      throw new Error(`failed to upload image${code || msg ? `: code=${code || "unknown"} msg=${msg || "unknown"}` : ""}`);
    }

    try {
      await this.sendFeishuReplyOrDirectMessage(
        chatId,
        "image",
        JSON.stringify({ image_key: imageKey }),
        options,
      );
    } catch (error) {
      throw new Error(`feishu image message send failed: ${describeSdkError(error)} | image_key=${imageKey}`);
    }
  }

  async replyFile(
    chatId: string,
    fileBase64: string,
    fileName: string,
    mimeType?: string,
    options?: FeishuSendOptions,
  ): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const fileBuffer = Buffer.from(fileBase64, "base64");
    if (fileBuffer.byteLength === 0) {
      throw new Error("empty file");
    }
    if (fileBuffer.byteLength > FEISHU_MAX_FILE_BYTES) {
      throw new Error("file too large (>30MB)");
    }

    const safeFileName = path.basename(fileName || `openclaw-${Date.now()}.bin`)
      .replace(/[\/\\]/g, "_")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim() || `openclaw-${Date.now()}.bin`;
    const uploadFileName = safeFileName.slice(0, 120) || `openclaw-${Date.now()}.bin`;
    const uploadFileType = this.detectFeishuUploadFileType(uploadFileName, mimeType);
    const tmpExt = path.extname(uploadFileName).trim() || ".bin";
    const tmpPath = path.join(
      os.tmpdir(),
      `tfclaw-feishu-${Date.now()}-${Math.random().toString(16).slice(2)}${tmpExt}`,
    );
    fs.writeFileSync(tmpPath, fileBuffer);

    let uploadResult: unknown;
    let fileStream: fs.ReadStream | undefined;
    try {
      fileStream = fs.createReadStream(tmpPath);
      uploadResult = await this.larkClient.im.v1.file.create({
        data: {
          file_type: uploadFileType,
          file_name: uploadFileName,
          file: fileStream,
        },
      });
    } catch (error) {
      throw new Error(`feishu file upload failed: ${describeSdkError(error)}`);
    } finally {
      try {
        fileStream?.destroy();
      } catch {
        // no-op
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // no-op
      }
    }

    const uploadObj = toObject(uploadResult);
    const uploadData = toObject(uploadObj.data);
    const fileKey = toString(uploadObj.file_key) || toString(uploadData.file_key);
    if (!fileKey) {
      const code = toString(uploadObj.code);
      const msg = toString(uploadObj.msg);
      throw new Error(`failed to upload file${code || msg ? `: code=${code || "unknown"} msg=${msg || "unknown"}` : ""}`);
    }

    const messageType = this.resolveFeishuMessageTypeByFileType(uploadFileType);
    try {
      await this.sendFeishuReplyOrDirectMessage(
        chatId,
        messageType,
        JSON.stringify({ file_key: fileKey }),
        options,
      );
    } catch (error) {
      throw new Error(`feishu file message send failed: ${describeSdkError(error)} | file_key=${fileKey}`);
    }
  }

  async replyAudio(
    chatId: string,
    audioBase64: string,
    fileName?: string,
    mimeType?: string,
    options?: FeishuSendOptions,
  ): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");
    if (audioBuffer.byteLength === 0) {
      throw new Error("empty audio");
    }
    if (audioBuffer.byteLength > FEISHU_MAX_FILE_BYTES) {
      throw new Error("audio too large (>30MB)");
    }

    const safeFileName = path.basename(fileName || `openclaw-${Date.now()}.opus`)
      .replace(/[\/\\]/g, "_")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim() || `openclaw-${Date.now()}.opus`;
    const preparedAudio = await this.prepareAudioForFeishuVoice(audioBuffer, safeFileName, mimeType);
    if (preparedAudio.buffer.byteLength > FEISHU_MAX_FILE_BYTES) {
      throw new Error("audio too large after preparation (>30MB)");
    }
    const safeBaseName = path.parse(safeFileName).name.trim() || `openclaw-${Date.now()}`;
    const originalExt = path.extname(safeFileName).trim().toLowerCase()
      || this.inferAudioExtFromMimeType(toString(mimeType))
      || ".bin";
    const uploadExt = preparedAudio.fileType === "opus" ? ".opus" : originalExt;
    const uploadFileName = `${safeBaseName.slice(0, 100) || `openclaw-${Date.now()}`}${uploadExt}`;
    const tmpPath = path.join(
      os.tmpdir(),
      `tfclaw-feishu-${Date.now()}-${Math.random().toString(16).slice(2)}${uploadExt}`,
    );
    fs.writeFileSync(tmpPath, preparedAudio.buffer);
    const audioDurationMs = await this.probeAudioDurationMs(tmpPath);

    let uploadResult: unknown;
    let audioStream: fs.ReadStream | undefined;
    try {
      audioStream = fs.createReadStream(tmpPath);
      uploadResult = await this.larkClient.im.v1.file.create({
        data: {
          file_type: preparedAudio.fileType,
          file_name: uploadFileName,
          file: audioStream,
          ...(audioDurationMs ? { duration: audioDurationMs } : {}),
        },
      });
    } catch (error) {
      throw new Error(`feishu audio upload failed: ${describeSdkError(error)}`);
    } finally {
      try {
        audioStream?.destroy();
      } catch {
        // no-op
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // no-op
      }
    }

    const uploadObj = toObject(uploadResult);
    const uploadData = toObject(uploadObj.data);
    const fileKey = toString(uploadObj.file_key) || toString(uploadData.file_key);
    if (!fileKey) {
      const code = toString(uploadObj.code);
      const msg = toString(uploadObj.msg);
      throw new Error(`failed to upload audio${code || msg ? `: code=${code || "unknown"} msg=${msg || "unknown"}` : ""}`);
    }

    const messageType: "audio" | "file" = preparedAudio.fileType === "opus" ? "audio" : "file";
    try {
      await this.sendFeishuReplyOrDirectMessage(
        chatId,
        messageType,
        JSON.stringify({ file_key: fileKey }),
        options,
      );
    } catch (error) {
      throw new Error(`feishu audio message send failed: ${describeSdkError(error)} | file_key=${fileKey}`);
    }
  }

  private async probeAudioDurationMs(filePath: string): Promise<number | undefined> {
    if (!(await this.commandExists("ffprobe"))) {
      return undefined;
    }
    const result = await this.runLocalCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      10_000,
    );
    if (result.code !== 0) {
      return undefined;
    }
    const raw = result.stdout.trim();
    if (!raw) {
      return undefined;
    }
    const seconds = Number.parseFloat(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }
    return Math.max(1, Math.round(seconds * 1000));
  }

  private inferAudioExtFromMimeType(mimeType: string): string {
    const normalized = mimeType.trim().split(";")[0]?.trim().toLowerCase() || "";
    switch (normalized) {
      case "audio/ogg":
      case "audio/opus":
      case "audio/opus+ogg":
      case "application/ogg":
        return ".opus";
      case "audio/mpeg":
      case "audio/mp3":
        return ".mp3";
      case "audio/wav":
      case "audio/x-wav":
        return ".wav";
      case "audio/aac":
        return ".aac";
      case "audio/flac":
        return ".flac";
      case "audio/amr":
        return ".amr";
      case "audio/mp4":
      case "audio/m4a":
      case "audio/x-m4a":
        return ".m4a";
      default:
        return "";
    }
  }

  private isOggOpusBuffer(buffer: Buffer): boolean {
    if (buffer.byteLength < 4) {
      return false;
    }
    if (buffer.subarray(0, 4).toString("ascii") !== "OggS") {
      return false;
    }
    return buffer.includes(Buffer.from("OpusHead"));
  }

  private async commandExists(command: string): Promise<boolean> {
    const probe = await this.runLocalCommand(
      "bash",
      ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`],
      5000,
    );
    return probe.code === 0;
  }

  private async runLocalCommand(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<CommandRunResult> {
    return await new Promise<CommandRunResult>((resolve) => {
      const child = spawn(command, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let finished = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let spawnError: Error | undefined;

      const finish = (code: number): void => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        resolve({
          code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          spawnError,
        });
      };

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // no-op
          }
          finish(124);
        }, timeoutMs);
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutChunks.push(buffer);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrChunks.push(buffer);
      });
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code) => {
        finish(typeof code === "number" ? code : 1);
      });
    });
  }

  private async prepareAudioForFeishuVoice(
    audioBuffer: Buffer,
    fileName: string,
    mimeType?: string,
  ): Promise<{ buffer: Buffer; fileType: "opus" | "stream" }> {
    const fileExt = path.extname(fileName).trim().toLowerCase();
    if (this.isOggOpusBuffer(audioBuffer) || fileExt === ".opus") {
      return {
        buffer: audioBuffer,
        fileType: "opus",
      };
    }
    if (!(await this.commandExists("ffmpeg"))) {
      return {
        buffer: audioBuffer,
        fileType: "stream",
      };
    }

    const inferredExt = fileExt || this.inferAudioExtFromMimeType(toString(mimeType));
    const safeInputExt = /^[a-z0-9.]{1,10}$/i.test(inferredExt) && inferredExt.startsWith(".") ? inferredExt : ".bin";
    const tempBase = `tfclaw-feishu-audio-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inputPath = path.join(os.tmpdir(), `${tempBase}${safeInputExt}`);
    const outputPath = path.join(os.tmpdir(), `${tempBase}.opus`);
    fs.writeFileSync(inputPath, audioBuffer);

    try {
      const result = await this.runLocalCommand(
        "ffmpeg",
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          inputPath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          outputPath,
        ],
        FEISHU_AUDIO_TRANSCODE_TIMEOUT_MS,
      );
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || result.spawnError?.message || "unknown error";
        console.warn(`[gateway] feishu audio transcode failed, fallback to stream upload: ${detail}`);
        return {
          buffer: audioBuffer,
          fileType: "stream",
        };
      }
      if (!fs.existsSync(outputPath)) {
        return {
          buffer: audioBuffer,
          fileType: "stream",
        };
      }
      const opusBuffer = fs.readFileSync(outputPath);
      if (opusBuffer.byteLength === 0) {
        return {
          buffer: audioBuffer,
          fileType: "stream",
        };
      }
      return {
        buffer: opusBuffer,
        fileType: "opus",
      };
    } finally {
      try {
        fs.unlinkSync(inputPath);
      } catch {
        // no-op
      }
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // no-op
      }
    }
  }

  private shouldDownloadInboundAttachment(messageType: string): boolean {
    return ["image", "file", "media", "video", "audio", "sticker", "post"].includes(messageType);
  }

  private inferInboundAttachmentFileName(
    messageType: string,
    contentObj: Record<string, unknown>,
    messageId: string,
  ): string {
    const normalizedType = messageType.trim().toLowerCase();
    if (normalizedType === "image") {
      const fromPayload = toString(contentObj.image_name, toString(contentObj.file_name)).trim();
      return path.basename(fromPayload || `image_${messageId || Date.now()}.png`);
    }
    const fromPayload = toString(contentObj.file_name, toString(contentObj.file, toString(contentObj.title))).trim();
    if (fromPayload) {
      return path.basename(fromPayload);
    }
    switch (normalizedType) {
      case "audio":
        return `audio_${messageId || Date.now()}.opus`;
      case "video":
      case "media":
        return `video_${messageId || Date.now()}.mp4`;
      case "sticker":
        return `sticker_${messageId || Date.now()}.webp`;
      default:
        return `${normalizedType || "file"}_${messageId || Date.now()}.bin`;
    }
  }

  private inferInboundAttachmentMimeType(messageType: string, fileName: string): string {
    const ext = path.extname(fileName).trim().toLowerCase();
    if (ext) {
      switch (ext) {
        case ".png":
          return "image/png";
        case ".jpg":
        case ".jpeg":
          return "image/jpeg";
        case ".webp":
          return "image/webp";
        case ".gif":
          return "image/gif";
        case ".pdf":
          return "application/pdf";
        case ".txt":
          return "text/plain";
        case ".csv":
          return "text/csv";
        case ".json":
          return "application/json";
        case ".mp3":
          return "audio/mpeg";
        case ".wav":
          return "audio/wav";
        case ".ogg":
        case ".opus":
          return "audio/ogg";
        case ".mp4":
          return "video/mp4";
        default:
          return "application/octet-stream";
      }
    }
    switch (messageType) {
      case "image":
        return "image/png";
      case "audio":
        return "audio/ogg";
      case "video":
      case "media":
        return "video/mp4";
      case "sticker":
        return "image/webp";
      default:
        return "application/octet-stream";
    }
  }

  private buildInboundAttachmentTargets(
    messageType: string,
    contentObj: Record<string, unknown>,
    messageId: string,
  ): Array<{
    logicalType: string;
    resourceType: "image" | "file";
    fileKey: string;
    fileName: string;
    mimeType: string;
  }> {
    const normalizedType = messageType.trim().toLowerCase();
    if (!this.shouldDownloadInboundAttachment(normalizedType)) {
      return [];
    }

    if (normalizedType === "post") {
      const parsedPost = parseFeishuPostContent(contentObj);
      const targets: Array<{
        logicalType: string;
        resourceType: "image" | "file";
        fileKey: string;
        fileName: string;
        mimeType: string;
      }> = [];
      for (let idx = 0; idx < parsedPost.imageKeys.length; idx += 1) {
        const key = parsedPost.imageKeys[idx]!;
        const fileName = `post_image_${idx + 1}_${messageId || Date.now()}.png`;
        targets.push({
          logicalType: "image",
          resourceType: "image",
          fileKey: key,
          fileName,
          mimeType: this.inferInboundAttachmentMimeType("image", fileName),
        });
      }
      for (let idx = 0; idx < parsedPost.mediaKeys.length; idx += 1) {
        const media = parsedPost.mediaKeys[idx]!;
        const fallbackName = `post_media_${idx + 1}_${messageId || Date.now()}.bin`;
        const fileName = path.basename(media.fileName || fallbackName);
        targets.push({
          logicalType: "file",
          resourceType: "file",
          fileKey: media.fileKey,
          fileName,
          mimeType: this.inferInboundAttachmentMimeType("file", fileName),
        });
      }
      return targets;
    }

    const fileKey = normalizedType === "image"
      ? toString(contentObj.image_key).trim()
      : toString(contentObj.file_key, toString(contentObj.media_id)).trim();
    if (!fileKey) {
      return [];
    }
    const fileName = this.inferInboundAttachmentFileName(normalizedType, contentObj, messageId);
    return [
      {
        logicalType: normalizedType === "sticker" ? "image" : normalizedType,
        resourceType: normalizedType === "image" ? "image" : "file",
        fileKey,
        fileName,
        mimeType: this.inferInboundAttachmentMimeType(normalizedType, fileName),
      },
    ];
  }

  private async readFeishuBinaryResponse(response: unknown): Promise<Buffer> {
    if (Buffer.isBuffer(response)) {
      return response;
    }
    if (response instanceof ArrayBuffer) {
      return Buffer.from(response);
    }
    const responseObj = response as {
      code?: unknown;
      msg?: unknown;
      data?: unknown;
      getReadableStream?: () => AsyncIterable<Uint8Array | Buffer>;
      writeFile?: (pathValue: string) => Promise<void>;
      [Symbol.asyncIterator]?: () => AsyncIterable<Uint8Array | Buffer>;
    };
    const code = toNumber(responseObj.code, 0);
    if (responseObj.code !== undefined && code !== 0) {
      throw new Error(`code=${code} msg=${toString(responseObj.msg, "unknown")}`);
    }
    if (Buffer.isBuffer(responseObj.data)) {
      return responseObj.data;
    }
    if (responseObj.data instanceof ArrayBuffer) {
      return Buffer.from(responseObj.data);
    }
    if (typeof responseObj.getReadableStream === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of responseObj.getReadableStream()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof responseObj[Symbol.asyncIterator] === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of responseObj as unknown as AsyncIterable<Uint8Array | Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof responseObj.writeFile === "function") {
      const tmpPath = path.join(
        os.tmpdir(),
        `tfclaw-feishu-download-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`,
      );
      try {
        await responseObj.writeFile(tmpPath);
        return fs.readFileSync(tmpPath);
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // no-op
        }
      }
    }
    throw new Error("unexpected feishu binary response format");
  }

  private async downloadInboundAttachments(
    messageType: string,
    contentObj: Record<string, unknown>,
    messageId: string,
  ): Promise<BridgeInboundAttachment[]> {
    if (!this.larkClient || !messageId || !this.shouldDownloadInboundAttachment(messageType)) {
      return [];
    }
    const normalizedType = messageType.trim().toLowerCase();
    const targets = this.buildInboundAttachmentTargets(normalizedType, contentObj, messageId);
    if (targets.length === 0) {
      return [];
    }
    const results: BridgeInboundAttachment[] = [];
    const seen = new Set<string>();

    for (const target of targets) {
      const dedupKey = `${target.resourceType}:${target.fileKey}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      try {
        const response = await this.larkClient.im.v1.messageResource.get({
          path: {
            message_id: messageId,
            file_key: target.fileKey,
          },
          params: {
            type: target.resourceType,
          },
        });
        const buffer = await this.readFeishuBinaryResponse(response);
        if (buffer.byteLength === 0) {
          continue;
        }
        if (buffer.byteLength > OPENCLAW_BRIDGE_INBOUND_MAX_FILE_BYTES) {
          throw new Error(`attachment too large (${buffer.byteLength} bytes)`);
        }
        results.push({
          messageType: target.logicalType,
          fileName: target.fileName,
          mimeType: target.mimeType,
          contentBase64: buffer.toString("base64"),
          sourceFileKey: target.fileKey,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[gateway] feishu inbound attachment download failed: ${msg} | message_id=${messageId} type=${normalizedType} file_key=${target.fileKey}`,
        );
      }
    }
    return results;
  }

  private async handleInboundEvent(data: unknown): Promise<void> {
    const root = toObject(data);
    const eventPayload = toObject(root.event);
    const inboundPayload = Object.keys(eventPayload).length > 0 ? eventPayload : root;
    const message = toObject(inboundPayload.message);
    const messageType = toString(message.message_type).trim().toLowerCase();
    const messageThreadId = toString(message.thread_id).trim();
    const messageRootId = toString(message.root_id).trim();
    if (!messageType) {
      return;
    }

    const rootHeader = toObject(root.header);
    const payloadHeader = toObject(inboundPayload.header);
    const eventHeader = Object.keys(rootHeader).length > 0 ? rootHeader : payloadHeader;
    const messageId = toString(message.message_id);
    const eventId = toString(eventHeader.event_id);
    const dedupKey = messageId || eventId;
    if (dedupKey && this.isDuplicateInbound(dedupKey)) {
      console.log(`[gateway] feishu duplicate message ignored: ${dedupKey}`);
      return;
    }

    const chatId = toString(message.chat_id);
    if (!chatId) {
      return;
    }

    const chatType = toString(message.chat_type).trim().toLowerCase() || "unknown";
    const senderObj = toObject(inboundPayload.sender);
    const senderIdObj = toObject(senderObj.sender_id);
    const senderOpenId = toString(senderIdObj.open_id);
    const senderUserId = toString(senderIdObj.user_id);
    const normalizedSenderId = senderOpenId || senderUserId;
    if (chatType === "group" && this.isOtherBotSender(senderUserId, senderOpenId)) {
      if (FEISHU_DEBUG_INBOUND) {
        console.log(
          `[gateway] feishu group message ignored (other bot sender): chat_id=${chatId} sender_open_id=${senderOpenId || "unknown"} sender_user_id=${senderUserId || "unknown"}`,
        );
      }
      return;
    }

    const rawContent = toString(message.content);
    let contentObj: Record<string, unknown> = {};
    if (rawContent) {
      try {
        contentObj = toObject(JSON.parse(rawContent));
      } catch {
        contentObj = {};
      }
    }
    const senderName = await this.resolveSenderDisplayName(
      senderObj,
      senderOpenId,
      senderUserId,
      contentObj,
      chatId,
      chatType,
    );
    const rawText = parseFeishuInboundMessageText(rawContent, messageType, contentObj);
    const attachments = await this.downloadInboundAttachments(messageType, contentObj, messageId);
    const mentions = extractFeishuMentions(message, contentObj);
    const hasAnyMention = mentions.length > 0;
    const mentionedBot = checkFeishuBotMentionedLikeOpenClaw(
      rawContent,
      messageType,
      contentObj,
      mentions,
      this.botOpenId,
      this.botName,
    );
    const text = normalizeFeishuMentionsLikeOpenClaw(
      rawText,
      mentions,
      chatType === "p2p" ? this.botOpenId : undefined,
    );
    const isSelfBotMessage = Boolean(this.botOpenId && senderOpenId && senderOpenId === this.botOpenId);
    if (isSelfBotMessage && isInternalFeishuMediaPlaceholderText(text || rawText)) {
      if (messageId) {
        await this.deleteMessage(messageId).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[gateway] failed to delete internal media placeholder message: ${detail}`);
        });
      }
      return;
    }
    const llmText = text;
    const isMentioned = chatType !== "group"
      ? true
      : mentionedBot;

    if (FEISHU_DEBUG_INBOUND) {
      console.log(
        `[gateway] feishu inbound: message_id=${messageId || "unknown"} chat_id=${chatId} chat_type=${chatType} message_type=${messageType} mentioned=${isMentioned} mentions=${mentions.length} text=${JSON.stringify(text).slice(0, 220)}`,
      );
    }

    const shouldAckReaction = FEISHU_ACK_REACTION_ENABLED
      && Boolean(messageId)
      && (chatType !== "group" || isMentioned);
    if (shouldAckReaction) {
      void this.addReaction(messageId).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[gateway] feishu add reaction failed: ${msg}`);
      });
    }

    const responder = this.buildInboundResponder(messageId || undefined, {
      replyInThread: chatType === "group" && Boolean(messageThreadId || messageRootId),
    });
    try {
      await this.router.handleInboundMessage({
        channel: "feishu",
        chatId,
        chatType,
        isMentioned,
        hasAnyMention,
        botOpenId: this.botOpenId || undefined,
        senderId: normalizedSenderId || undefined,
        senderOpenId: senderOpenId || undefined,
        senderUserId: senderUserId || undefined,
        senderName: senderName || undefined,
        mentions,
        messageId: messageId || undefined,
        eventId: eventId || undefined,
        messageType,
        contentRaw: rawContent,
        contentObj,
        attachments,
        text,
        llmText: llmText || text,
        rawEvent: inboundPayload,
        allowFrom: this.config.allowFrom,
        responder,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[gateway] failed to process feishu inbound message: ${msg}`);
      try {
        await responder.replyText(chatId, formatGatewayErrorFeedback("gateway", error));
      } catch (replyError) {
        const fallbackMsg = replyError instanceof Error ? replyError.message : String(replyError);
        console.error(`[gateway] feishu failed to send error reply: ${fallbackMsg}`);
      }
    }
  }
}

class WhatsAppChatApp implements ChatApp {
  readonly name = "whatsapp";
  readonly enabled: boolean;

  constructor(private readonly config: WhatsAppChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] whatsapp connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class TelegramChatApp implements ChatApp {
  readonly name = "telegram";
  readonly enabled: boolean;

  constructor(private readonly config: TelegramChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] telegram connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class DiscordChatApp implements ChatApp {
  readonly name = "discord";
  readonly enabled: boolean;

  constructor(private readonly config: DiscordChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] discord connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class MochatChatApp implements ChatApp {
  readonly name = "mochat";
  readonly enabled: boolean;

  constructor(private readonly config: MochatChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] mochat connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class DingTalkChatApp implements ChatApp {
  readonly name = "dingtalk";
  readonly enabled: boolean;

  constructor(private readonly config: DingTalkChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] dingtalk connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class EmailChatApp implements ChatApp {
  readonly name = "email";
  readonly enabled: boolean;

  constructor(private readonly config: EmailChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] email connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class SlackChatApp implements ChatApp {
  readonly name = "slack";
  readonly enabled: boolean;

  constructor(private readonly config: SlackChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] slack connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class QqChatApp implements ChatApp {
  readonly name = "qq";
  readonly enabled: boolean;

  constructor(private readonly config: QQChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] qq connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class ChatAppManager {
  private readonly apps: ChatApp[];

  constructor(config: GatewayConfig, router: TfclawCommandRouter) {
    this.apps = [
      new WhatsAppChatApp(config.channels.whatsapp),
      new TelegramChatApp(config.channels.telegram),
      new DiscordChatApp(config.channels.discord),
      new FeishuChatApp(config.channels.feishu, router),
      new MochatChatApp(config.channels.mochat),
      new DingTalkChatApp(config.channels.dingtalk),
      new EmailChatApp(config.channels.email),
      new SlackChatApp(config.channels.slack),
      new QqChatApp(config.channels.qq),
    ];
  }

  get enabledChannels(): string[] {
    return this.apps.filter((app) => app.enabled).map((app) => app.name);
  }

  async startAll(): Promise<void> {
    for (const app of this.apps) {
      if (!app.enabled) {
        continue;
      }
      try {
        await app.connect();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[gateway] failed to connect ${app.name}: ${msg}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const app of this.apps) {
      if (!app.enabled) {
        continue;
      }
      try {
        await app.close();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[gateway] failed to close ${app.name}: ${msg}`);
      }
    }
  }
}
// SECTION: bootstrap
async function bootstrap(): Promise<void> {
  let loaded: LoadedGatewayConfig;
  try {
    loaded = loadGatewayConfig();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[gateway] startup failed: ${msg}`);
    process.exit(1);
    return;
  }

  const bridgeHost = hostFromUrl(loaded.config.nexchatbot.baseUrl);
  const relayHost = hostFromUrl(loaded.config.relay.url);
  const openclawHost = hostFromUrl(`http://${loaded.config.openclawBridge.gatewayHost}`);
  const localNoProxyHosts = [
    "127.0.0.1",
    "localhost",
    "::1",
    bridgeHost,
    relayHost,
    openclawHost,
  ].filter((item) => isLocalNoProxyHost(item));
  if (localNoProxyHosts.length > 0) {
    mergeNoProxyHosts(localNoProxyHosts);
    console.log(`[gateway] local no_proxy applied: ${(process.env.NO_PROXY ?? "").trim()}`);
  }

  const relay = new RelayBridge(loaded.config.relay.url, loaded.config.relay.token, "feishu");
  const nexChatBridge = new NexChatBridgeClient(loaded.config.nexchatbot);
  const openclawBridge = new OpenClawPerUserBridge(loaded.config.openclawBridge);
  const accessManager = new TfclawAccessManager(
    loaded.config.openclawBridge.stateDir,
    loaded.config.openclawBridge.userHomeRoot,
  );
  const configuredSuperRoot = accessManager.readConfiguredSuperRootIdentifier();
  if (configuredSuperRoot) {
    const bindings = await openclawBridge.listUserBindings();
    let resolvedSuperRoot = "";
    const byUserKey = bindings.find((item) => item.userKey === configuredSuperRoot);
    if (byUserKey) {
      resolvedSuperRoot = byUserKey.userKey;
    } else {
      const byLinuxUser = bindings.find((item) => item.linuxUser === configuredSuperRoot);
      if (byLinuxUser) {
        resolvedSuperRoot = byLinuxUser.userKey;
      }
    }
    if (!resolvedSuperRoot) {
      resolvedSuperRoot = (await accessManager.resolveUserAlias(configuredSuperRoot)) || "";
    }
    if (!resolvedSuperRoot && /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(configuredSuperRoot)) {
      resolvedSuperRoot = configuredSuperRoot;
    }
    if (resolvedSuperRoot) {
      await accessManager.setSuperRootFromConfig(resolvedSuperRoot);
      console.log(`[gateway] super_root loaded from local config: ${resolvedSuperRoot}`);
    } else {
      console.warn(
        `[gateway] super_root local config unresolved: ${configuredSuperRoot}. Use feishu user key, known name, or mapped linux user.`,
      );
    }
  }
  const router = new TfclawCommandRouter(relay, nexChatBridge, openclawBridge, accessManager);
  const chatApps = new ChatAppManager(loaded.config, router);

  relay.connect();
  await chatApps.startAll();

  const enabledChannels = chatApps.enabledChannels;
  console.log("[gateway] TFClaw gateway started");
  console.log(`[gateway] config: ${loaded.configPath}${loaded.fromFile ? "" : " (env fallback)"}`);
  console.log(`[gateway] enabled channels: ${enabledChannels.length > 0 ? enabledChannels.join(", ") : "(none)"}`);
  if (nexChatBridge.enabled) {
    console.log(
      `[gateway] nexchatbot bridge: enabled -> ${joinHttpUrl(loaded.config.nexchatbot.baseUrl, loaded.config.nexchatbot.runPath)}`,
    );
  } else {
    console.log("[gateway] nexchatbot bridge: disabled");
  }
  if (openclawBridge.enabled) {
    console.log(
      `[gateway] openclaw bridge: enabled -> root=${loaded.config.openclawBridge.openclawRoot}, stateDir=${loaded.config.openclawBridge.stateDir}, sharedEnvPath=${loaded.config.openclawBridge.sharedEnvPath}, sharedSkillsDir=${loaded.config.openclawBridge.sharedSkillsDir}, userHomeRoot=${loaded.config.openclawBridge.userHomeRoot}, userPrefix=${loaded.config.openclawBridge.userPrefix}, portRange=${loaded.config.openclawBridge.gatewayPortBase}-${loaded.config.openclawBridge.gatewayPortMax}`,
    );
  } else {
    console.log("[gateway] openclaw bridge: disabled");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down...`);
    await chatApps.stopAll();
    relay.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (process.env.TFCLAW_FEISHU_GATEWAY_SKIP_BOOTSTRAP !== "1") {
  void bootstrap();
}

export const __tfclawGatewayTestHooks = {
  FeishuChatApp,
  RelayBridge,
  NexChatBridgeClient,
  OpenClawPerUserBridge,
  TfclawAccessManager,
  TfclawCommandRouter,
  loadGatewayConfig,
};
