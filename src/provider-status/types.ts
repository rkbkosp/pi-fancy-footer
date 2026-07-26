import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderStatusSnapshot } from "../shared.ts";

export type HeaderLike = Record<
  string,
  string | number | boolean | undefined | null
>;

export interface ProviderStatusSource {
  id: string;
  label: string;
  usageUrl: string;
  preserveMissingWindows: boolean;
  fetch(pi: ExtensionAPI): Promise<ProviderStatusSnapshot>;
  parseHeaders(
    headers: HeaderLike,
    now?: Date,
  ): ProviderStatusSnapshot | undefined;
}

export type ModelLike = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  provider?: unknown;
  providerId?: unknown;
};
