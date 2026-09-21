import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { availableLoopbackPort } from "../scripts/network-port";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe("availableLoopbackPort", () => {
  it("asks the OS for a port that is not already bound", async () => {
    const occupied = createServer(); servers.push(occupied);
    await new Promise<void>((resolve, reject) => occupied.once("error", reject).listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");

    expect(await availableLoopbackPort()).not.toBe(address.port);
  });
});
