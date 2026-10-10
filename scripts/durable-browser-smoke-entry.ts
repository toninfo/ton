import * as durable from "@ton/pi-durable";
import * as environment from "@ton/pi-durable/env";
import * as jsonl from "@ton/pi-durable/storage/jsonl";
import * as sqlite from "@ton/pi-durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
