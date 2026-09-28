import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({limit:"4mb"}));
app.use(express.static(path.join(__dirname,"public")));

const SYSTEM = `Te Pista AI vagy, egy magyar nyelvű személyes AI ügynök.
Nem csak válaszolsz: ha szükséges, eszközöket (tools) használsz.
Mindig a lehető legkevesebb szükséges tool-hívással dolgozz.
A tool eredményét használd fel a végső válaszban.
Ha friss internetes információ kell, használd a web_search eszközt.
Ne állítsd, hogy valamit végrehajtottál, ha nincs hozzá eszközöd.`;

const TOOLS = [
  {
    name:"web_search",
    description:"Aktuális információ keresése az interneten. Használd hírekhez, árakhoz, friss adatokhoz vagy olyan kérdéshez, ahol a tudás időérzékeny.",
    parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}
  },
  {
    name:"calculator",
    description:"Matematikai számítás elvégzése.",
    parameters:{type:"object",properties:{expression:{type:"string"}},required:["expression"]}
  }
];

async function gemini(promptMessages) {
  const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body={
    systemInstruction:{parts:[{text:SYSTEM}]},
    contents:promptMessages.map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]})),
    tools:[{functionDeclarations:TOOLS}],
    generationConfig:{temperature:.5,maxOutputTokens:2500}
  };
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();
  if(!r.ok) throw new Error(d?.error?.message||"Gemini hiba");
  return d;
}

async function groq(messages) {
  const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.GROQ_API_KEY}`},
    body:JSON.stringify({
      model:"llama-3.3-70b-versatile",
      messages:[{role:"system",content:SYSTEM},...messages],
      tools:TOOLS.map(t=>({type:"function",function:t})),
      tool_choice:"auto",temperature:.5,max_tokens:2500
    })
  });
  const d=await r.json();
  if(!r.ok) throw new Error(d?.error?.message||"Groq hiba");
  return d;
}

async function webSearch(query){
  if(!process.env.TAVILY_API_KEY) {
    return "Nincs TAVILY_API_KEY beállítva. A webes kereső eszköz jelenleg nincs aktiválva.";
  }
  const r=await fetch("https://api.tavily.com/search",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({api_key:process.env.TAVILY_API_KEY,query,max_results:5,search_depth:"basic"})
  });
  const d=await r.json();
  if(!r.ok) throw new Error(d?.message||"Webkeresési hiba");
  return (d.results||[]).map(x=>`${x.title}\n${x.url}\n${x.content}`).join("\n\n");
}

function calculate(expression){
  if(!/^[0-9+\-*/().,%\s]+$/.test(expression)) throw new Error("Biztonsági okból ez a kifejezés nem számolható.");
  const safe=expression.replace(/%/g,"/100");
  return String(Function(`"use strict"; return (${safe})`)());
}

async function runTool(name,args){
  if(name==="web_search") return await webSearch(args.query);
  if(name==="calculator") return calculate(args.expression);
  throw new Error(`Ismeretlen tool: ${name}`);
}

async function chatGemini(messages){
  let current=await gemini(messages);
  for(let i=0;i<4;i++){
    const part=current.candidates?.[0]?.content;
    const calls=part?.parts?.filter(p=>p.functionCall);
    if(!calls?.length){
      return part?.parts?.map(p=>p.text||"").join("")||"Nincs válasz.";
    }
    const toolParts=[];
    for(const p of calls){
      const result=await runTool(p.functionCall.name,p.functionCall.args||{});
      toolParts.push({functionResponse:{name:p.functionCall.name,response:{result}}});
    }
    const contents=messages.map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]}));
    contents.push({role:"model",parts:calls.map(x=>({functionCall:x.functionCall}))});
    contents.push({role:"user",parts:toolParts});
    const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      systemInstruction:{parts:[{text:SYSTEM}]},contents,tools:[{functionDeclarations:TOOLS}]
    })});
    current=await r.json();
  }
  return "A feladat túl sok eszközlépést igényelt.";
}

async function chatGroq(messages){
  let current=await groq(messages);
  for(let i=0;i<4;i++){
    const m=current.choices?.[0]?.message;
    if(!m?.tool_calls?.length) return m?.content||"Nincs válasz.";
    const next=[...messages,{role:"assistant",content:m.content||"",tool_calls:m.tool_calls}];
    for(const call of m.tool_calls){
      let result;
      try{ result=await runTool(call.function.name,JSON.parse(call.function.arguments||"{}")); }
      catch(e){ result=`Tool hiba: ${e.message}`; }
      next.push({role:"tool",tool_call_id:call.id,content:String(result)});
    }
    current=await groq(next);
    messages=next;
  }
  return "A feladat túl sok eszközlépést igényelt.";
}

app.get("/api/status",(req,res)=>res.json({
  ok:true,gemini:!!process.env.GEMINI_API_KEY,groq:!!process.env.GROQ_API_KEY,
  web:!!process.env.TAVILY_API_KEY
}));

app.post("/api/chat",async(req,res)=>{
  try{
    const {messages,provider="gemini"}=req.body;
    if(!Array.isArray(messages)||!messages.length) return res.status(400).json({error:"Nincs üzenet."});
    let answer=provider==="groq"
      ? await chatGroq(messages)
      : await chatGemini(messages);
    res.json({answer});
  }catch(e){console.error(e);res.status(500).json({error:e.message});}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Pista AI V2: http://localhost:${PORT}`));