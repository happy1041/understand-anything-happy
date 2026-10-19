import {createElement,useEffect} from "react";
import {act,create,type ReactTestRenderer} from "react-test-renderer";
import fs from "node:fs";
import {expect,it} from "vitest";
import {validateGraph} from "@understand-anything/core/schema";
import {useDashboardStore} from "../../store";
import {resolveTourTargets} from "../../utils/tourTargets";
import {useLayerDetailGraph} from "../GraphView";
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let current:ReturnType<typeof useLayerDetailGraph>;
function Probe(){
 current=useLayerDetailGraph();
 const g=useDashboardStore(s=>s.graph);
 const selected=useDashboardStore(s=>s.selectedNodeId);
 const highlighted=useDashboardStore(s=>s.tourHighlightedNodeIds);
 const layers=useDashboardStore(s=>s.nodeIdToLayerId);
 useEffect(()=>{
  const targets=resolveTourTargets(selected?[selected]:highlighted,g?.edges??[],new Set([...current.nodeToContainer.keys(),...current.nodes.map(n=>n.id)]),layers);
  for(const id of targets){const cid=current.nodeToContainer.get(id);if(cid&&cid!==id)useDashboardStore.getState().expandContainer(cid);}
 },[g,selected,highlighted,layers,current.nodeToContainer,current.nodes]);
 return null;
}
it.skipIf(!process.env.TOUR_PROJECT_GRAPH)("walks the real graph forward/back and exposes Coupler and nested methods using real ELK",async()=>{
 const g=validateGraph(JSON.parse(fs.readFileSync(process.env.TOUR_PROJECT_GRAPH!,"utf8"))).data!;
 const s=useDashboardStore;s.setState(s.getInitialState(),true);s.getState().setGraph(g);
 let renderer:ReactTestRenderer;await act(async()=>{renderer=create(createElement(Probe));});
 const settle=async()=>{
  for(let i=0;i<150;i++){
   await act(async()=>{await new Promise(r=>setTimeout(r,10));});
   const state=s.getState();const candidates=new Set([...current.nodeToContainer.keys(),...current.nodes.map(n=>n.id)]);
   const targets=resolveTourTargets(state.selectedNodeId?[state.selectedNodeId]:state.tourHighlightedNodeIds,g.edges,candidates,state.nodeIdToLayerId);
   if(current.layoutStatus==="ready"&&targets.length&&targets.every(id=>current.nodes.some(n=>n.id===id))){
    expect(s.getState().layoutIssues.filter(i=>i.level==="fatal")).toEqual([]);
    return;
   }
  }
  throw new Error(`unsettled ${s.getState().activeLayerId}: ${current.nodes.map(n=>n.id).join(",")}`);
 };
 try{
  await act(async()=>s.getState().startTour());await settle();
  for(let i=1;i<g.tour.length;i++){await act(async()=>s.getState().nextTourStep());await settle();}
  for(let i=g.tour.length-2;i>=0;i--){await act(async()=>s.getState().prevTourStep());await settle();}
  const coupler=g.nodes.find(n=>n.type==="class"&&n.name==="Coupler")!;
  await act(async()=>s.getState().navigateToNodeInLayer(coupler.id));await settle();
  expect(current.nodes.some(n=>n.id===coupler.id)).toBe(true);
  const method=g.nodes.find(n=>n.name==="Coupler.add_mechanism")!;
  await act(async()=>s.getState().navigateToNodeInLayer(method.id));await settle();
  expect(current.nodes.some(n=>n.id===method.id)).toBe(true);
 }finally{await act(async()=>renderer!.unmount());}
},15000);
