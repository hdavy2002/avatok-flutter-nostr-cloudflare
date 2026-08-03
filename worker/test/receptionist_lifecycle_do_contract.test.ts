import { describe, expect, it } from "vitest";
import { ReceptionRoom } from "../src/do/reception_room";
import { ReceptionRoomCf } from "../src/do/reception_room_cf";

function harness(Room: new (state: any, env: any) => any) {
  const commands: Array<Record<string, unknown>> = [];
  const stub = {
    fetch: async (_url: string, init: RequestInit) => {
      commands.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    },
  };
  const env = {
    CALL_ROOMS: {
      idFromName: (id: string) => id,
      get: () => stub,
    },
  };
  const room = new Room({ waitUntil: (_p: Promise<unknown>) => {} }, env);
  room.init = { sid: "sid-1", call_id: "avatok-call" };
  return { room, commands };
}

describe.each([
  ["Gemini", ReceptionRoom],
  ["Cloudflare", ReceptionRoomCf],
] as const)("%s receptionist lifecycle", (_name, Room) => {
  it.each(["receptionist_connected", "receptionist_failed"] as const)(
    "reports %s to the owning CallRoom",
    async (command) => {
      const { room, commands } = harness(Room as any);
      await room.reportServiceOutcome(command);
      expect(commands).toEqual([{
        callId: "avatok-call",
        command,
        commandId: `${command}:sid-1`,
      }]);
    },
  );
});
