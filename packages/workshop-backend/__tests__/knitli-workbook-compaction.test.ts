// Compaction's fold of spreadsheet attachment bindings (src/fork/workbook-names.ts), ported from
// twinprime19/cloudflare-os (321aa306).
import {describe, expect, it} from "vitest";
import type {AiChatAuthorInfo, AiChatMessage, AiChatMessageBody} from "@gadgets/workshop-shared/api";
import {buildCompactionState} from "../src/agent-compaction";
import type {ChatBindingEntry} from "../src/storage-schema/overseer-storage";

const user: AiChatAuthorInfo = {type: "user", id: "user", name: "User"};
const agent: AiChatAuthorInfo = {type: "agent", id: "model", name: "Agent"};

function record(
    sequence: number, author: AiChatAuthorInfo, body: AiChatMessageBody): AiChatMessage {
  return {chatId: 1, sequence, timestamp: new Date(sequence), author, ...body};
}

function message(sequence: number, author: AiChatAuthorInfo, text: string): AiChatMessage {
  return record(sequence, author, {type: "message", message: text});
}

const initialBindings: [string, ChatBindingEntry][] = [
  ["APP", {type: "workpiece", id: 1}],
];

function buildState(messages: AiChatMessage[], compactedTo: number) {
  return buildCompactionState(messages, compactedTo, initialBindings, undefined);
}

// Replay binds a spreadsheet attachment under a name derived from its file name. Once compaction
// passes the upload, replay starts from the checkpoint's binding map instead of the message, so the
// fold has to carry the same name for the same attachment id, or `env.<name>` and readSheet reach
// nothing after compaction.
describe("compaction checkpoint workbook bindings", () => {
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const gadget: AiChatAuthorInfo = {type: "gadget", id: "mailbox", name: "Mailbox"};

  function upload(sequence: number, author: AiChatAuthorInfo,
                  files: {id: string, name: string, convertedFrom?: string}[]): AiChatMessage {
    return record(sequence, author, {
      type: "message", message: "see attached",
      attachments: files.map(({id, name, convertedFrom = XLSX}) =>
          ({id, name, mimeType: "text/markdown", size: 1, convertedFrom})),
    });
  }

  function pendingRequest(sequence: number, bindingName: string): AiChatMessage {
    return record(sequence, agent, {
      type: "connectionRequest", requestId: `1:${sequence}`, vendorId: "vendor",
      vendorName: "Vendor", reason: "Needed", state: "pending", bindingName,
    });
  }

  it("binds a user's spreadsheet below the boundary to its attachment id", () => {
    let state = buildState([upload(0, user, [{id: "file-a", name: "big.xlsx"}])], 1);

    expect(state.chatBindings).toEqual([
      ["APP", {type: "workpiece", id: 1}],
      ["big_xlsx", {type: "attachment", id: "file-a"}],
    ]);
  });

  it("binds a gadget's imported spreadsheet the same way", () => {
    let state = buildState([upload(0, gadget, [{id: "file-g", name: "big.xlsx"}])], 1);

    expect(state.chatBindings).toContainEqual(["big_xlsx", {type: "attachment", id: "file-g"}]);
  });

  it("suffixes past a name a pending connection request holds, as replay does", () => {
    let state = buildState([
      pendingRequest(0, "big_xlsx"),
      upload(1, user, [{id: "file-a", name: "big.xlsx"}]),
    ], 2);

    expect(state.chatBindings).toEqual([
      ["APP", {type: "workpiece", id: 1}],
      ["big_xlsx_2", {type: "attachment", id: "file-a"}],
    ]);
  });

  it("keeps clear of a denied request's name too, so denying one never renames a workbook", () => {
    let state = buildState([
      record(0, agent, {
        type: "connectionRequest", requestId: "1:0", vendorId: "vendor", vendorName: "Vendor",
        reason: "Needed", state: "denied", bindingName: "big_xlsx",
      }),
      upload(1, user, [{id: "file-a", name: "big.xlsx"}]),
    ], 2);

    expect(state.chatBindings).toContainEqual(["big_xlsx_2", {type: "attachment", id: "file-a"}]);
  });

  it("names two same-named spreadsheets in one message in attachment order", () => {
    let state = buildState([upload(0, user, [
      {id: "file-a", name: "report.xlsx"},
      {id: "file-b", name: "report.xlsx"},
    ])], 1);

    expect(state.chatBindings).toEqual([
      ["APP", {type: "workpiece", id: 1}],
      ["report_xlsx", {type: "attachment", id: "file-a"}],
      ["report_xlsx_2", {type: "attachment", id: "file-b"}],
    ]);
  });

  it("binds nothing for an attachment uploaded before workbooks were bound", () => {
    let state = buildState([record(0, user, {
      type: "message", message: "see attached",
      attachments: [{id: "file-a", name: "big.xlsx", mimeType: "text/markdown", size: 1}],
    })], 1);

    expect(state.chatBindings).toEqual([["APP", {type: "workpiece", id: 1}]]);
  });

  it("binds nothing for an agent message's attachments, which replay does not render", () => {
    let state = buildState([upload(0, agent, [{id: "file-a", name: "big.xlsx"}])], 1);

    expect(state.chatBindings).toEqual([["APP", {type: "workpiece", id: 1}]]);
  });

  it("keeps earlier workbooks through a second compaction and suffixes a reused file name", () => {
    let log = [
      upload(0, user, [{id: "file-a", name: "big.xlsx"}]),
      message(1, agent, "read it"),
      upload(2, user, [{id: "file-b", name: "big.xlsx"}]),
      message(3, agent, "read that too"),
    ];
    let first = {chatId: 1, compactedTo: 2, summary: "earlier", ...buildState(log, 2)};
    expect(first.chatBindings).toContainEqual(["big_xlsx", {type: "attachment", id: "file-a"}]);

    // The second fold sees only the messages past the first boundary, as replay does.
    let second = buildCompactionState(log.slice(2), 4, initialBindings, first);
    expect(second.chatBindings).toEqual([
      ["APP", {type: "workpiece", id: 1}],
      ["big_xlsx", {type: "attachment", id: "file-a"}],
      ["big_xlsx_2", {type: "attachment", id: "file-b"}],
    ]);
  });
});

