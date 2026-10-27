import type { startMyelinRuntime } from "@the-metafactory/cortex/bus";
import type { BusConfig } from "./bus-contract.ts";
import type { BusSigner } from "./bus-producer.ts";

export function busRuntimeStartArgs({ bus, signer, url, credsPath, name }: {
 bus: BusConfig; signer: BusSigner; url: string; credsPath: string; name: "ranger" | "ranger-ci-test";
}): Parameters<typeof startMyelinRuntime> {
 const config = { agent: { name: "ranger", displayName: "Ranger" }, nats: { url, name, subjects: [], credsPath } } as unknown as Parameters<typeof startMyelinRuntime>[0];
 return [config, {
  jetstreamDomain: bus.target.domain, signer: { principal: signer.issuer, rawSeedBytes: signer.seed },
  signFailureMode: "drop", stack: bus.routing.stack, principal: bus.routing.principal,
 }];
}
