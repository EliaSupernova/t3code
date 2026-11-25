import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Volume2Icon, VolumeXIcon } from "lucide-react";
import { useEffect } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  readAloudProblemAtom,
  startReadAloud,
  watchReadAloudThread,
} from "../../readAloud/readAloud";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { Toggle } from "../ui/toggle";

/** The speaker button in the chat header. While on, it also speaks the thread it sits above. */
export function ReadAloudToggle({
  environmentId,
  threadId,
  isServerThread,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  isServerThread: boolean;
}) {
  const gt = useGT();
  const enabled = useClientSettings((settings) => settings.readAloudEnabled);
  const problem = useAtomValue(readAloudProblemAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the audio player to the open thread's updates and releases it
  useEffect(() => {
    if (!enabled) return;
    return watchReadAloudThread(scopeThreadRef(environmentId, threadId), isServerThread);
  }, [enabled, environmentId, threadId, isServerThread]);
  const label =
    problem === "missing-key"
      ? gt("No ElevenLabs key found")
      : enabled
        ? gt("Stop reading replies aloud")
        : gt("Read replies aloud");
  return (
    <SharedTooltipTrigger render={<span className="flex shrink-0" />} label={label} side="bottom">
      <Toggle
        className="shrink-0 [-webkit-app-region:no-drag]"
        pressed={enabled}
        onPressedChange={(pressed) => {
          if (pressed) void startReadAloud(environmentId);
          else void updateClientSettings({ readAloudEnabled: false });
        }}
        aria-label={gt("Read replies aloud")}
        variant="ghost"
        size="sm"
      >
        {enabled ? <Volume2Icon className="size-4" /> : <VolumeXIcon className="size-4" />}
      </Toggle>
    </SharedTooltipTrigger>
  );
}
