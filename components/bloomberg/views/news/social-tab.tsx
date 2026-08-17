"use client";

import { ExternalLink, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BloombergButton } from "../../core/bloomberg-button";
import { PLATFORMS, PLATFORM_INFO, SOCIAL_KEY } from "./constants";
import { timeAgo } from "./helpers";
import type { Platform, SocialHandle, SocialPost, ThemeColors } from "./types";

/** Multi-platform social feed — X/Nitter, YouTube, Reddit, generic RSS. */
export function SocialTab({ colors }: { colors: ThemeColors }) {
  const [socialHandles, setSocialHandles] = useState<SocialHandle[]>([]);
  const [socialPosts, setSocialPosts] = useState<SocialPost[]>([]);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialError, setSocialError] = useState<string | null>(null);
  const [newHandle, setNewHandle] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>("youtube");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SOCIAL_KEY);
      if (saved) {
        const parsed: { platform: string; handle: string }[] = JSON.parse(saved);
        const valid = parsed.filter((h) =>
          (PLATFORMS as string[]).includes(h.platform)
        ) as SocialHandle[];
        setSocialHandles(valid);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchSocialPosts = useCallback(async (handles: SocialHandle[]) => {
    if (!handles.length) return;
    setSocialLoading(true);
    setSocialError(null);
    try {
      const map: Record<string, string[]> = {};
      for (const { platform, handle } of handles) {
        if (!map[platform]) map[platform] = [];
        map[platform].push(handle);
      }
      const res = await fetch(
        `/api/news/social?handles=${encodeURIComponent(JSON.stringify(map))}&limit=80`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSocialPosts(data.posts ?? []);
      if (data.errors?.length)
        setSocialError(`Some sources failed: ${data.errors.slice(0, 3).join(" · ")}`);
    } catch {
      setSocialError("Failed to connect to backend. Make sure the Python backend is running.");
    } finally {
      setSocialLoading(false);
    }
  }, []);

  useEffect(() => {
    if (socialHandles.length > 0 && socialPosts.length === 0) fetchSocialPosts(socialHandles);
  }, [socialHandles, socialPosts.length, fetchSocialPosts]);

  const normalizeHandle = (platform: Platform, raw: string): string => {
    const s = raw.trim().replace(/\/+$/, "");
    if (platform === "twitter") return s.replace(/^@/, "");
    if (platform === "reddit") return s.replace(/^\/?(r\/)?/, "");
    if (platform === "youtube" && s.includes("youtube.com/")) {
      const m = s.match(/\/(?:channel\/|@)([\w-]+)/);
      if (m) return s.includes("/channel/") ? m[1] : `@${m[1]}`;
    }
    return s;
  };

  const handleAddHandle = () => {
    const handle = normalizeHandle(selectedPlatform, newHandle);
    if (!handle) return;
    const already = socialHandles.some(
      (h) => h.platform === selectedPlatform && h.handle === handle
    );
    if (already) {
      setNewHandle("");
      return;
    }
    const updated = [...socialHandles, { platform: selectedPlatform, handle }];
    setSocialHandles(updated);
    localStorage.setItem(SOCIAL_KEY, JSON.stringify(updated));
    setNewHandle("");
    fetchSocialPosts(updated);
  };

  const handleRemoveHandle = (platform: Platform, handle: string) => {
    const updated = socialHandles.filter((h) => !(h.platform === platform && h.handle === handle));
    setSocialHandles(updated);
    localStorage.setItem(SOCIAL_KEY, JSON.stringify(updated));
    setSocialPosts((prev) => prev.filter((p) => !(p.platform === platform && p.handle === handle)));
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {/* Add handle bar */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b"
        style={{ borderColor: colors.border }}
      >
        <select
          value={selectedPlatform}
          onChange={(e) => setSelectedPlatform(e.target.value as Platform)}
          className="bg-transparent text-xs font-bold font-mono outline-none border px-1.5 py-0.5 cursor-pointer"
          style={{ borderColor: colors.border, color: PLATFORM_INFO[selectedPlatform].color }}
        >
          {PLATFORMS.map((p) => (
            <option
              key={p}
              value={p}
              style={{ color: PLATFORM_INFO[p].color, backgroundColor: colors.surface }}
            >
              {PLATFORM_INFO[p].label}
            </option>
          ))}
        </select>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAddHandle();
          }}
          className="flex-1 flex items-center gap-1"
        >
          <input
            type="text"
            value={newHandle}
            onChange={(e) => setNewHandle(e.target.value)}
            placeholder={PLATFORM_INFO[selectedPlatform].placeholder}
            className="flex-1 bg-transparent text-xs outline-none font-mono placeholder:opacity-30 min-w-0"
            style={{ color: colors.text }}
          />
          <button
            type="submit"
            className="shrink-0 p-0.5 hover:opacity-70"
            style={{ color: colors.accent }}
            disabled={!newHandle.trim()}
            aria-label="Add"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </form>

        {socialHandles.length > 0 && (
          <BloombergButton
            color="default"
            onClick={() => {
              setSocialPosts([]);
              fetchSocialPosts(socialHandles);
            }}
            disabled={socialLoading}
          >
            <RefreshCw className={`h-3 w-3 ${socialLoading ? "animate-spin" : "mr-1"}`} />
            {!socialLoading && "REFRESH"}
          </BloombergButton>
        )}
      </div>

      {/* Followed handles chips */}
      {socialHandles.length > 0 && (
        <div
          className="shrink-0 flex flex-wrap gap-1.5 px-2 py-1.5 border-b"
          style={{ borderColor: colors.border }}
        >
          {socialHandles.map(({ platform, handle }) => {
            const info = PLATFORM_INFO[platform];
            return (
              <div
                key={`${platform}:${handle}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold border font-mono"
                style={{ borderColor: `${info.color}66`, color: info.color }}
              >
                <span className="opacity-70">{info.label}</span>
                <span>{handle}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveHandle(platform, handle)}
                  className="hover:opacity-60 ml-0.5"
                  aria-label={`Remove ${handle}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#333 #000" }}
      >
        {socialError && (
          <div
            className="m-2 p-2 text-xs border"
            style={{
              borderColor: colors.negative,
              color: colors.negative,
              backgroundColor: `${colors.negative}10`,
            }}
          >
            {socialError}
          </div>
        )}

        {socialHandles.length === 0 && (
          <div className="py-16 text-center space-y-3">
            <p className="text-[10px] font-bold" style={{ color: colors.textSecondary }}>
              No sources added yet
            </p>
            <div className="text-xs space-y-1 opacity-60" style={{ color: colors.textSecondary }}>
              <p>YouTube: UCxxxxx or @ChannelHandle</p>
              <p>Reddit: wallstreetbets or r/investing</p>
              <p>Facebook: BeautyInvestor (via RSSHub)</p>
              <p>X/Twitter: elonmusk (via Nitter)</p>
              <p>RSS: https://example.com/feed.rss</p>
            </div>
          </div>
        )}

        {socialLoading && (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="h-4 w-4 animate-spin mr-2" style={{ color: colors.accent }} />
            <span className="text-xs" style={{ color: colors.textSecondary }}>
              Fetching social feed…
            </span>
          </div>
        )}

        {!socialLoading && socialPosts.length > 0 && (
          <div className="divide-y" style={{ borderColor: colors.border }}>
            {socialPosts.map((post, i) => {
              const info = PLATFORM_INFO[post.platform];
              return (
                <a
                  key={post.url || `${post.platform}-${post.handle}-${i}`}
                  href={post.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 px-3 py-1.5 hover:bg-[#111111] transition-colors group"
                >
                  <span
                    className="shrink-0 mt-0.5 text-[9px] font-bold px-1 py-0.5 whitespace-nowrap"
                    style={{
                      backgroundColor: `${info.color}22`,
                      color: info.color,
                      border: `1px solid ${info.color}55`,
                    }}
                  >
                    {info.label}
                  </span>

                  <div
                    className="shrink-0 mt-0.5 text-[10px] text-right w-20 leading-tight"
                    style={{ color: colors.textSecondary }}
                  >
                    <div className="truncate">{post.display_name || post.handle}</div>
                    <div>{timeAgo(post.published_at)}</div>
                  </div>

                  <span
                    className="flex-1 text-[10px] leading-snug group-hover:underline"
                    style={{ color: colors.text }}
                  >
                    {post.title || "(no title)"}
                  </span>

                  <ExternalLink
                    className="shrink-0 h-2.5 w-2.5 mt-0.5 opacity-0 group-hover:opacity-60"
                    style={{ color: colors.textSecondary }}
                  />
                </a>
              );
            })}
          </div>
        )}

        {!socialLoading && !socialError && socialHandles.length > 0 && socialPosts.length === 0 && (
          <div className="py-10 text-center text-xs" style={{ color: colors.textSecondary }}>
            No posts returned. Sources may be unavailable or handles are incorrect.
          </div>
        )}
      </div>
    </div>
  );
}
