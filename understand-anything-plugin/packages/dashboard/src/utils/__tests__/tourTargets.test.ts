import { describe, expect, it } from "vitest";
import type { GraphEdge } from "@understand-anything/core/types";
import { resolveTourTargets } from "../tourTargets";

const contains = (source: string, target: string): GraphEdge => ({source, target, type:"contains", direction:"forward", weight:1});
const edges = [contains("file", "class"), contains("class", "method")];
describe("tour references in the current view", () => {
  it("fits the file once when file view hides the class and method", () => {
    expect(resolveTourTargets(["file","class","method"],edges,new Set(["file"]))).toEqual(["file"]);
  });
  it("uses the nearest visible owner in class view", () => {
    expect(resolveTourTargets(["method"],edges,new Set(["file","class"]))).toEqual(["class"]);
  });
  it("keeps a method when it is rendered", () => {
    expect(resolveTourTargets(["method"],edges,new Set(["file","class","method"]))).toEqual(["method"]);
  });
  it("uses a portal for cross-layer highlights, with inherited file membership", () => {
    expect(resolveTourTargets(["method"],edges,new Set(["portal:other"]),new Map([["file","other"]]))).toEqual(["portal:other"]);
  });
  it("uses the layer card in overview", () => {
    expect(resolveTourTargets(["method"],edges,new Set(["other"]),new Map([["file","other"]]))).toEqual(["other"]);
  });
  it("skips filtered or missing targets without waiting, and survives containment cycles", () => {
    expect(resolveTourTargets(["method","missing"],[...edges,contains("method","file")],new Set())).toEqual([]);
  });
});
