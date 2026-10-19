import {createElement} from "react";
import {act,create,type ReactTestRenderer} from "react-test-renderer";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {KnowledgeGraph} from "@understand-anything/core/types";
import type {ElkInput,ElkLayoutResult} from "../../utils/elk-layout";
import {useDashboardStore} from "../../store";
import {useLayerDetailTopology} from "../GraphView";

const {jobs}=vi.hoisted(()=>({jobs:[] as {input:ElkInput;resolve:(r:ElkLayoutResult)=>void}[]}));
vi.mock("../../utils/elk-layout",()=>({applyElkLayout:(input:ElkInput)=>new Promise<ElkLayoutResult>(resolve=>jobs.push({input,resolve}))}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let latest: ReturnType<typeof useLayerDetailTopology>;
function Probe(){latest=useLayerDetailTopology();return null;}
let renderer:ReactTestRenderer;
function fixture():KnowledgeGraph{
 const files=["a/port/one","a/port/two","a/upstream/one","a/upstream/two","b/port/one","b/port/two","b/upstream/one","b/upstream/two"];
 return {version:"1.0.0",project:{name:"layout-race",languages:[],frameworks:[],description:"",analyzedAt:"2026-10-19",gitCommitHash:"test"},
 nodes:[...files.map(id=>({id,type:"file" as const,name:id,filePath:id,summary:id,tags:[],complexity:"simple" as const})),
 {id:"classA",type:"class",name:"classA",filePath:files[0],summary:"",tags:[],complexity:"simple"},
 {id:"methodA",type:"function",name:"methodA",filePath:files[0],summary:"",tags:[],complexity:"simple"}],
 edges:[{source:files[0],target:"classA",type:"contains",direction:"forward",weight:1},{source:"classA",target:"methodA",type:"contains",direction:"forward",weight:1}],
 layers:[{id:"A",name:"A",description:"",nodeIds:files.slice(0,4)},{id:"B",name:"B",description:"",nodeIds:files.slice(4)}],tour:[]};
}
async function finish(job:typeof jobs[number]){const index=jobs.indexOf(job);if(index>=0)jobs.splice(index,1);await act(async()=>job.resolve({positioned:{...job.input,children:job.input.children.map((c,i)=>({...c,x:i*350,y:50}))},issues:[]}));}
beforeEach(async()=>{
 jobs.length=0;
 useDashboardStore.setState(useDashboardStore.getInitialState(),true);
 useDashboardStore.getState().setGraph(fixture());
 useDashboardStore.getState().drillIntoLayer("A");
 await act(async()=>{renderer=create(createElement(Probe));});
});
afterEach(async()=>{await act(async()=>renderer.unmount());});
describe("asynchronous layer layout lifecycle",()=>{
 it("does not expose A's topology while B's layout is still pending",async()=>{
  await finish(jobs.shift()!);
  expect(latest.filteredNodes.some(n=>n.id.startsWith("a/"))).toBe(true);
  await act(async()=>useDashboardStore.getState().drillIntoLayer("B"));
  expect(latest.filteredNodes).toEqual([]);
  await finish(jobs.find(j=>j.input.id==="layer")!);
  expect(latest.filteredNodes.every(n=>n.id.startsWith("b/"))).toBe(true);
 });
 it("cannot start a child layout for A after switching to B",async()=>{
  await finish(jobs.shift()!);
  const container=latest.containers[0].id;
  await act(async()=>useDashboardStore.getState().drillIntoLayer("B"));
  await act(async()=>useDashboardStore.getState().expandContainer(container));
  expect(jobs.filter(j=>j.input.id!=="layer")).toHaveLength(0);
 });
 it("drops a late child-layout result from a departed layer",async()=>{
  await finish(jobs.shift()!);
  const container=latest.containers[0].id;
  await act(async()=>useDashboardStore.getState().expandContainer(container));
  const childJob=jobs.find(j=>j.input.id===container)!;
  expect(childJob).toBeDefined();
  await act(async()=>useDashboardStore.getState().drillIntoLayer("B"));
  await finish(childJob);
  expect(useDashboardStore.getState().containerLayoutCache.size).toBe(0);
  await finish(jobs.find(j=>j.input.id==="layer")!);
  expect(latest.filteredNodes.every(n=>n.id.startsWith("b/"))).toBe(true);
 });
 it("recomputes a cache whose child positions belong to another container generation",async()=>{
  await finish(jobs.shift()!);
  const container=latest.containers[0];
  await act(async()=>{
   useDashboardStore.getState().setContainerLayout(container.id,new Map([["other-layer-file",{x:1,y:1}]]),{width:300,height:200});
   useDashboardStore.getState().expandContainer(container.id);
  });
  const job=jobs.find(j=>j.input.id===container.id)!;
  expect(job.input.children.map(c=>c.id)).toEqual(container.nodeIds);
  await finish(job);
  expect([...useDashboardStore.getState().containerLayoutCache.get(container.id)!.childPositions.keys()]).toEqual(container.nodeIds);
 });
 it("includes class methods when the functions toggle is enabled",async()=>{
  await act(async()=>{
   useDashboardStore.getState().setDetailLevel("class");
   useDashboardStore.getState().toggleShowFunctionsInClassView();
  });
  await finish(jobs[jobs.length-1]);
  expect(latest.filteredNodes.map(n=>n.id)).toContain("methodA");
 });
});
