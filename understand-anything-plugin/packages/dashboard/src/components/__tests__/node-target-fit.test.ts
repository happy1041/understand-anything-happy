import {createElement} from "react";
import {act,create,type ReactTestRenderer} from "react-test-renderer";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {useDashboardStore} from "../../store";
import {NodeTargetFitView} from "../GraphView";

const canvas=vi.hoisted(()=>({
 nodes:[] as {id:string}[],
 measured:new Map<string,{measured:{width:number;height:number}}>(),
 fit:vi.fn(),
}));
vi.mock("@xyflow/react",async(importOriginal)=>({
 ...await importOriginal<typeof import("@xyflow/react")>(),
 useNodes:()=>canvas.nodes,
 useReactFlow:()=>({fitView:canvas.fit,getInternalNode:(id:string)=>canvas.measured.get(id)}),
}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let renderer:ReactTestRenderer;
const view=(requestKey="A",targetNodeIds=["a"],isTourRequest=true)=>createElement(NodeTargetFitView,{requestKey,targetNodeIds,isTourRequest});
beforeEach(()=>{
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
 vi.stubGlobal("window",globalThis);
 vi.stubGlobal("requestAnimationFrame",(cb:FrameRequestCallback)=>setTimeout(()=>cb(performance.now()),16));
 vi.stubGlobal("cancelAnimationFrame",(id:ReturnType<typeof setTimeout>)=>clearTimeout(id));
 canvas.nodes=[];canvas.measured.clear();canvas.fit.mockReset();
 useDashboardStore.setState(useDashboardStore.getInitialState(),true);
});
afterEach(async()=>{if(renderer)await act(async()=>renderer.unmount());vi.useRealTimers();vi.unstubAllGlobals();});
const measure=(id:string)=>canvas.measured.set(id,{measured:{width:200,height:100}});
describe("camera target lifecycle",()=>{
 it("fits a measured target on the next frame without waiting for the timeout",async()=>{
  measure("a");await act(async()=>{renderer=create(view());});
  await act(async()=>{vi.advanceTimersByTime(16);});
  expect(canvas.fit).toHaveBeenCalledOnce();
  expect(canvas.fit.mock.calls[0][0].nodes).toEqual([{id:"a"}]);
  expect(useDashboardStore.getState().tourFitPending).toBe(false);
 });
 it("keeps the original deadline when repeated node updates restart the effect",async()=>{
  await act(async()=>{renderer=create(view());});
  await act(async()=>{vi.advanceTimersByTime(1000);});
  canvas.nodes=[{id:"container"}];await act(async()=>renderer.update(view()));
  await act(async()=>{vi.advanceTimersByTime(500);});
  expect(canvas.fit).toHaveBeenCalledOnce();
  expect(useDashboardStore.getState().tourFitPending).toBe(false);
 });
 it("refits after a step A -> B -> A return",async()=>{
  measure("a");measure("b");await act(async()=>{renderer=create(view());});
  await act(async()=>{vi.advanceTimersByTime(16);});
  await act(async()=>renderer.update(view("B",["b"])));
  await act(async()=>{vi.advanceTimersByTime(16);});
  await act(async()=>renderer.update(view()));
  await act(async()=>{vi.advanceTimersByTime(16);});
  expect(canvas.fit.mock.calls.map(c=>c[0].nodes[0].id)).toEqual(["a","b","a"]);
 });
 it("upgrades a timed-out fallback when its actual target arrives later",async()=>{
  await act(async()=>{renderer=create(view());});
  await act(async()=>{vi.advanceTimersByTime(1500);});
  measure("a");canvas.nodes=[{id:"a"}];await act(async()=>renderer.update(view()));
  await act(async()=>{vi.advanceTimersByTime(16);});
  expect(canvas.fit).toHaveBeenCalledTimes(2);
  expect(canvas.fit.mock.calls[1][0].nodes).toEqual([{id:"a"}]);
 });
 it("waits for layout completion and refits the same node after positions change",async()=>{
  measure("a");await act(async()=>{renderer=create(view());});
  await act(async()=>{vi.advanceTimersByTime(16);});
  await act(async()=>renderer.update(createElement(NodeTargetFitView,{requestKey:"A",targetNodeIds:["a"],isTourRequest:true,layoutPending:true})));
  await act(async()=>{vi.advanceTimersByTime(100);});
  expect(canvas.fit).toHaveBeenCalledTimes(1);
  await act(async()=>renderer.update(view()));
  await act(async()=>{vi.advanceTimersByTime(16);});
  expect(canvas.fit).toHaveBeenCalledTimes(2);
 });
 it("clears pending positioning when the request is stopped",async()=>{
  await act(async()=>{renderer=create(view());});
  expect(useDashboardStore.getState().tourFitPending).toBe(true);
  await act(async()=>renderer.update(view("",[])));
  await act(async()=>{vi.advanceTimersByTime(2000);});
  expect(canvas.fit).not.toHaveBeenCalled();
  expect(useDashboardStore.getState().tourFitPending).toBe(false);
 });
});
