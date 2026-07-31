'use client';
import React, { useEffect } from 'react';
import Script from 'next/script';

export default function Home() {
  useEffect(() => {
    let initialized = false;

    const initEditor = () => {
      if (initialized) return;
      
      const pdfjsLib = (window as any).pdfjsLib;
      const PDFLib = (window as any).PDFLib;
      const Tesseract = (window as any).Tesseract;

      // Check if all libraries are loaded from CDN
      if (!pdfjsLib || !PDFLib || !Tesseract) {
        setTimeout(initEditor, 100);
        return;
      }

      initialized = true;
      setupEditor(pdfjsLib, PDFLib, Tesseract);
    };

    const setupEditor = (pdfjsLib: any, PDFLib: any, Tesseract: any) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

      /* ============================================================
         STATE
         ============================================================ */
      let pdfjsDoc: any = null;
      let originalBytes: any = null;
      let scale = 1.5;
      let pages: any[] = [];          // per-page state objects
      let activeImgObj: any = null; // currently selected image element (for toolbar actions)

      const el = (id: string) => document.getElementById(id) as any;
      const statusEl = el('status');
      
      function setStatus(msg: string){ statusEl.textContent = msg || ''; }
      
      function showLoading(msg: string){ 
        el('loadingMsg').textContent = msg; 
        el('loadingOverlay').style.display='flex'; 
      }
      
      function hideLoading(){ 
        el('loadingOverlay').style.display='none'; 
      }

      /* ============================================================
         UNDO
         ============================================================ */
      let undoStack: any[] = [];
      function pushUndo(fn: any){
        undoStack.push(fn);
        if(undoStack.length>150) undoStack.shift();
        updateUndoButton();
      }
      function undo(){
        const fn = undoStack.pop();
        if(fn){ try{ fn(); }catch(e){ console.warn('undo failed', e); } }
        updateUndoButton();
      }
      function updateUndoButton(){
        el('btnUndo').disabled = undoStack.length===0;
      }
      el('btnUndo').onclick = undo;
      document.addEventListener('keydown', (e: any)=>{
        const isUndoCombo = (e.ctrlKey||e.metaKey) && !e.shiftKey && e.key.toLowerCase()==='z';
        if(!isUndoCombo) return;
        // while actively typing inside a run, let the browser's native contentEditable
        // undo handle fine-grained keystroke undo; our stack handles committed actions
        if(document.activeElement && (document.activeElement as any).isContentEditable) return;
        e.preventDefault();
        undo();
      });

      /* ============================================================
         FILE OPEN
         ============================================================ */
      el('btnOpen').onclick = () => el('fileInput').click();
      el('btnOpen2').onclick = () => el('fileInput').click();
      
      el('fileInput').onchange = (e: any) => { 
        if(e.target.files[0]) openFile(e.target.files[0]); 
      };

      const dropCard = el('dropCard');
      ['dragenter','dragover'].forEach(ev=> {
        dropCard.addEventListener(ev, (e: any) => {
          e.preventDefault();
          dropCard.classList.add('drag');
        });
      });
      
      ['dragleave','drop'].forEach(ev=> {
        dropCard.addEventListener(ev, (e: any) => {
          e.preventDefault();
          dropCard.classList.remove('drag');
        });
      });
      
      dropCard.addEventListener('drop', (e: any) => { 
        if(e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]); 
      });

      async function openFile(file: any){
        showLoading('Loading PDF…');
        undoStack = [];
        updateUndoButton();
        try{
          const buf = await file.arrayBuffer();
          originalBytes = buf.slice(0);
          pdfjsDoc = await pdfjsLib.getDocument({data: buf}).promise;
          pages = new Array(pdfjsDoc.numPages).fill(null);

          el('dropzone').style.display = 'none';
          el('pageStack').style.display = 'block';
          el('sidebar').style.display = 'block';
          ['btnInsertText','btnInsertImage','btnZoomOut','btnZoomIn','btnExport'].forEach(id=>el(id).disabled=false);

          await buildThumbnails();
          for(let i=1;i<=pdfjsDoc.numPages;i++){ await renderPage(i); }
          setStatus(file.name);
        }catch(err: any){
          console.error(err);
          alert('Could not open this PDF: ' + err.message);
        }finally{
          hideLoading();
        }
      }

      async function buildThumbnails(){
        const sb = el('sidebar'); sb.innerHTML='';
        for(let i=1;i<=pdfjsDoc.numPages;i++){
          const page = await pdfjsDoc.getPage(i);
          const vp = page.getViewport({scale:0.18});
          const c = document.createElement('canvas'); c.width=vp.width; c.height=vp.height;
          await page.render({canvasContext:c.getContext('2d'), viewport:vp}).promise;
          const wrap = document.createElement('div');
          wrap.className = 'thumb' + (i===1?' active':'');
          wrap.innerHTML = `<img src="${c.toDataURL()}"><div class="num">${i}</div>`;
          wrap.onclick = () => {
            document.querySelectorAll('#sidebar .thumb').forEach(t=>t.classList.remove('active'));
            wrap.classList.add('active');
            const target = document.getElementById('page-shell-'+i);
            if(target) target.scrollIntoView({behavior:'smooth', block:'start'});
          };
          sb.appendChild(wrap);
        }
      }

      /* ============================================================
         FONT CLASSIFICATION (approximate mapping to standard fonts)
         ============================================================ */
      function classifyFont(fontName: string, styleInfo: any){
        const name = (fontName||'').toLowerCase();
        const family = (styleInfo && styleInfo.fontFamily || '').toLowerCase();
        let generic = 'sans';
        if(name.includes('times')||name.includes('georgia')||name.includes('serif')||name.includes('roman')||name.includes('minion')||name.includes('garamond')||family.includes('serif')&&!family.includes('sans')){
          generic = 'serif';
        }
        if(name.includes('courier')||name.includes('mono')||name.includes('consolas')||family.includes('monospace')){
          generic = 'mono';
        }
        const bold = /bold|black|heavy|semibold/.test(name) || (styleInfo && styleInfo.fontWeight >= 600);
        const italic = /italic|oblique/.test(name) || (styleInfo && styleInfo.fontStyle === 'italic');
        const cssFamily = generic==='serif' ? "'Georgia','Times New Roman',serif"
                          : generic==='mono' ? "'IBM Plex Mono','Consolas',monospace"
                          : "'Helvetica','Arial',sans-serif";
        return {generic, bold, italic, cssFamily};
      }
      
      function standardFontFor(generic: string, bold: boolean, italic: boolean){
        if(generic==='serif'){
          if(bold&&italic) return StandardFonts.TimesRomanBoldItalic;
          if(bold) return StandardFonts.TimesRomanBold;
          if(italic) return StandardFonts.TimesRomanItalic;
          return StandardFonts.TimesRoman;
        }
        if(generic==='mono'){
          if(bold&&italic) return StandardFonts.CourierBoldOblique;
          if(bold) return StandardFonts.CourierBold;
          if(italic) return StandardFonts.CourierOblique;
          return StandardFonts.Courier;
        }
        if(bold&&italic) return StandardFonts.HelveticaBoldOblique;
        if(bold) return StandardFonts.HelveticaBold;
        if(italic) return StandardFonts.HelveticaOblique;
        return StandardFonts.Helvetica;
      }

      /* ============================================================
         COLOR SAMPLING
         ============================================================ */
      function sampleInkColor(ctx: any, x0: number, y0: number, x1: number, y1: number, bg: any){
        x0=Math.max(0,Math.floor(x0)); y0=Math.max(0,Math.floor(y0));
        x1=Math.ceil(x1); y1=Math.ceil(y1);
        const w = Math.max(1,x1-x0), h = Math.max(1,y1-y0);
        if(w<=0||h<=0) return bg.ink;
        let data;
        try{ data = ctx.getImageData(x0,y0,w,h).data; }catch(e){ return bg.ink; }
        let best: any =null,bestDist=-1;
        for(let i=0;i<data.length;i+=4){
          const r=data[i],g=data[i+1],b=data[i+2],a=data[i+3];
          if(a<40) continue;
          const dist = Math.abs(r-bg.r)+Math.abs(g-bg.g)+Math.abs(b-bg.b);
          if(dist>bestDist){bestDist=dist; best=[r,g,b];}
        }
        if(!best || bestDist<18) return bg.ink;
        return `rgb(${best[0]},${best[1]},${best[2]})`;
      }
      
      function sampleBackground(ctx: any, w: number, h: number){
        const pts = [[4,4],[w-4,4],[4,h-4],[w-4,h-4],[w/2,4]];
        const counts: any = {};
        let best=[255,255,255];
        pts.forEach(([x,y])=>{
          try{
            const d = ctx.getImageData(Math.max(0,Math.floor(x)),Math.max(0,Math.floor(y)),1,1).data;
            const key = d[0]+','+d[1]+','+d[2];
            counts[key]=(counts[key]||0)+1;
          }catch(e){}
        });
        let top=null,topN=0;
        for(const k in counts){ if(counts[k]>topN){topN=counts[k]; top=k;} }
        if(top){ const [r,g,b]=top.split(',').map(Number); best=[r,g,b]; }
        return {r:best[0],g:best[1],b:best[2],css:`rgb(${best[0]},${best[1]},${best[2]})`,ink:'rgb(20,20,20)'};
      }

      /* ============================================================
         RENDER PAGE  (canvas + extract text runs + extract images)
         ============================================================ */
      async function renderPage(pageNum: number){
        const page = await pdfjsDoc.getPage(pageNum);
        const viewport = page.getViewport({scale});

        const shell = document.createElement('div');
        shell.className = 'page-shell';
        shell.id = 'page-shell-'+pageNum;
        shell.style.width = viewport.width+'px';
        shell.style.height = viewport.height+'px';

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        const ctx = canvas.getContext('2d') as any;
        await page.render({canvasContext:ctx, viewport}).promise;

        const bg = sampleBackground(ctx, viewport.width, viewport.height);

        const textLayer = document.createElement('div');
        textLayer.className='text-layer';
        textLayer.style.width=viewport.width+'px';
        textLayer.style.height=viewport.height+'px';

        const imageLayer = document.createElement('div');
        imageLayer.className='image-layer';
        imageLayer.style.width=viewport.width+'px';
        imageLayer.style.height=viewport.height+'px';

        const pageState: any = {
          pageNum, viewport, canvas, ctx, bg,
          runs: [],      // text runs
          images: [],    // image objects
          isScanned: false,
          ocrApplied: false
        };

        // ---- extract text ----
        const textContent = await page.getTextContent();
        const runs = [];
        for(const item of textContent.items as any[]){
          if(!item.str || !item.str.trim()) continue;
          const style = textContent.styles[item.fontName] || {};
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const angleRad = Math.atan2(tx[1], tx[0]);
          const fontHeight = Math.hypot(tx[2], tx[3]);
          const widthPx = item.width * (viewport.scale);
          const left = tx[4];
          const ascent = (style.ascent && style.ascent>0 && style.ascent<1.2) ? style.ascent : 0.8;
          const top = tx[5] - fontHeight*ascent;
          const cls = classifyFont(item.fontName, style);
          const color = sampleInkColor(ctx, left, top, left+widthPx, top+fontHeight, bg);
          runs.push({
            id: 'r'+pageNum+'_'+runs.length,
            text: item.str,
            left, top, width: Math.max(widthPx,4), height: fontHeight,
            fontSize: fontHeight, angleRad, color,
            generic: cls.generic, bold: cls.bold, italic: cls.italic, cssFamily: cls.cssFamily,
            origLeft:left, origTop:top, origWidth:Math.max(widthPx,4)
          });
        }
        pageState.isScanned = runs.length===0;
        pageState.runs = runs;

        // ---- extract images via operator list ----
        const opList = await page.getOperatorList();
        const imgs = [];
        let ctm = [1,0,0,1,0,0];
        const stack: any[] = [];
        const mul = (a: number[], b: number[])=>[
          a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
          a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
          a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]
        ];
        function bboxFromCtm(curCtm: number[]){
          const full = mul(viewport.transform, curCtm);
          const pts = [[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>[
            full[0]*x+full[2]*y+full[4], full[1]*x+full[3]*y+full[5]
          ]);
          const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
          return {left:Math.min(...xs), top:Math.min(...ys), right:Math.max(...xs), bottom:Math.max(...ys)};
        }
        for(let i=0;i<opList.fnArray.length;i++){
          const fn = opList.fnArray[i], args = opList.argsArray[i];
          if(fn===pdfjsLib.OPS.save){ stack.push(ctm.slice()); }
          else if(fn===pdfjsLib.OPS.restore){ ctm = stack.pop() || [1,0,0,1,0,0]; }
          else if(fn===pdfjsLib.OPS.transform){ ctm = mul(ctm, args); }
          else if(fn===pdfjsLib.OPS.paintImageXObject || fn===pdfjsLib.OPS.paintJpegXObject){
            const b = bboxFromCtm(ctm);
            if((b.right-b.left)>6 && (b.bottom-b.top)>6){
              imgs.push({id:'i'+pageNum+'_'+imgs.length, key:args[0], inline:null as any, left:b.left, top:b.top, width:b.right-b.left, height:b.bottom-b.top, rotation:0, dataUrl:null as any, deleted:false});
            }
          }
          else if(fn===pdfjsLib.OPS.paintInlineImageXObject){
            const b = bboxFromCtm(ctm);
            if((b.right-b.left)>6 && (b.bottom-b.top)>6){
              imgs.push({id:'i'+pageNum+'_'+imgs.length, key:null as any, inline:args[0], left:b.left, top:b.top, width:b.right-b.left, height:b.bottom-b.top, rotation:0, dataUrl:null as any, deleted:false});
            }
          }
        }
        // resolve raster data for each (isolated so one bad image can't block the page)
        await Promise.all(imgs.map(async (im)=>{
          try{
            let obj = im.inline;
            if(!obj && im.key){
              obj = await Promise.race([
                new Promise((resolve)=>{
                  if(page.objs.has(im.key)) resolve(page.objs.get(im.key));
                  else page.objs.get(im.key, resolve);
                }),
                new Promise((resolve)=>setTimeout(()=>resolve(null), 4000))
              ]);
            }
            im.dataUrl = imageObjToDataUrl(obj);
          }catch(e){ console.warn('image extract failed', im.id, e); }
        }));
        pageState.images = imgs.filter(i=>i.dataUrl);

        // ---- erase original text + images from raster (they become live DOM/objects) ----
        ctx.save();
        ctx.fillStyle = bg.css;
        for(const r of runs){
          ctx.fillRect(r.left-1, r.top-1, r.width+2, r.height+2);
        }
        for(const im of pageState.images){
          ctx.fillRect(im.left-1, im.top-1, im.width+2, im.height+2);
        }
        ctx.restore();

        shell.appendChild(canvas);
        shell.appendChild(imageLayer);
        shell.appendChild(textLayer);
        el('pageStack').appendChild(shell);

        pageState.textLayerEl = textLayer;
        pageState.imageLayerEl = imageLayer;
        pages[pageNum-1] = pageState;

        runs.forEach(r=>mountRun(pageState, r));
        pageState.images.forEach((im: any)=>mountImage(pageState, im));

        // ---- OCR fallback for scanned pages ----
        if(pageState.isScanned){
          await ocrPage(pageState);
        }
      }

      function imageObjToDataUrl(obj: any){
        if(!obj) return null;
        try{
          if((typeof ImageBitmap!=='undefined' && obj instanceof ImageBitmap) ||
             (typeof HTMLImageElement!=='undefined' && obj instanceof HTMLImageElement) ||
             (typeof HTMLCanvasElement!=='undefined' && obj instanceof HTMLCanvasElement)){
            const w = obj.width, h = obj.height;
            if(!w||!h) return null;
            const c = document.createElement('canvas'); c.width=w; c.height=h;
            (c.getContext('2d') as any).drawImage(obj,0,0,w,h);
            return c.toDataURL('image/png');
          }
          if(obj.bitmap){
            const bmp = obj.bitmap;
            const w = obj.width||bmp.width, h = obj.height||bmp.height;
            if(!w||!h) return null;
            const c = document.createElement('canvas'); c.width=w; c.height=h;
            (c.getContext('2d') as any).drawImage(bmp,0,0,w,h);
            return c.toDataURL('image/png');
          }
          const w = obj.width, h = obj.height;
          if(!w||!h||!obj.data) return null;
          const c = document.createElement('canvas'); c.width=w; c.height=h;
          const cctx = c.getContext('2d') as any;
          const imgData = cctx.createImageData(w,h);
          const src = obj.data;
          if(src.length === w*h*4){
            imgData.data.set(src);
          } else if(src.length === w*h*3){
            for(let i=0,j=0;i<src.length;i+=3,j+=4){
              imgData.data[j]=src[i]; imgData.data[j+1]=src[i+1]; imgData.data[j+2]=src[i+2]; imgData.data[j+3]=255;
            }
          } else if(src.length === w*h){
            for(let i=0,j=0;i<src.length;i++,j+=4){
              imgData.data[j]=src[i]; imgData.data[j+1]=src[i]; imgData.data[j+2]=src[i]; imgData.data[j+3]=255;
            }
          } else {
            return null;
          }
          cctx.putImageData(imgData,0,0);
          return c.toDataURL('image/png');
        }catch(e){
          console.warn('imageObjToDataUrl failed', e);
          return null;
        }
      }

      /* ============================================================
         OCR (scanned pages) — reconstruct editable text objects
         ============================================================ */
      async function ocrPage(pageState: any){
        showLoading('Scanning page '+pageState.pageNum+' (OCR)…');
        try{
          const dataUrl = pageState.canvas.toDataURL('image/png');
          const { data } = await Tesseract.recognize(dataUrl, 'eng', { logger: (m: any)=>{
            if(m.status==='recognizing text') setStatus('OCR page '+pageState.pageNum+': '+Math.round(m.progress*100)+'%');
          }});
          const words = data.words || [];
          const bg = pageState.bg;
          const ctx = pageState.ctx;
          for(const w of words){
            if(!w.text || !w.text.trim() || w.confidence<35) continue;
            const {x0,y0,x1,y1} = w.bbox;
            const height = y1-y0, width = x1-x0;
            if(width<=0||height<=0) continue;
            const color = sampleInkColor(ctx, x0,y0,x1,y1, bg);
            const run = {
              id:'ocr'+pageState.pageNum+'_'+pageState.runs.length,
              text:w.text, left:x0, top:y0-height*0.12, width, height:height*1.15,
              fontSize:height*1.15, angleRad:0, color,
              generic:'sans', bold:false, italic:false, cssFamily:"'Helvetica','Arial',sans-serif",
              origLeft:x0, origTop:y0-height*0.12, origWidth:width, ocr:true
            };
            pageState.runs.push(run);
            ctx.save(); ctx.fillStyle=bg.css; ctx.fillRect(x0-1,y0-1,width+2,height+2); ctx.restore();
            mountRun(pageState, run);
          }
          pageState.ocrApplied = true;
          setStatus('OCR complete — page '+pageState.pageNum+' text is now editable');
        }catch(e){
          console.error('OCR failed', e);
          setStatus('OCR failed on page '+pageState.pageNum);
        }finally{
          hideLoading();
        }
      }

      /* ============================================================
         TEXT RUN — DOM mounting, editing, local reflow
         ============================================================ */
      function mountRun(pageState: any, run: any){
        const span = document.createElement('div');
        span.className = 'run' + (run.isNew?' new-text':'');
        span.contentEditable = 'false';
        span.spellcheck = false;
        span.dataset.runId = run.id;
        span.textContent = run.text;
        styleRun(span, run);
        pageState.textLayerEl.appendChild(span);
        run.el = span;
 
        // chrome = move handle + resize handle, lives as a sibling (never nested inside
        // the contentEditable element, so it can't be typed into or deleted by backspace)
        const chrome = document.createElement('div');
        chrome.className = 'run-chrome';
        const moveHandle = document.createElement('div'); moveHandle.className='handle move'; moveHandle.title='Drag to move';
        const resizeHandle = document.createElement('div'); resizeHandle.className='handle resize'; resizeHandle.title='Drag to resize text';
        chrome.appendChild(moveHandle); chrome.appendChild(resizeHandle);
        pageState.textLayerEl.appendChild(chrome);
        run.chromeEl = chrome;
        syncChrome(run);
 
        moveHandle.addEventListener('mousedown', (e: any)=>{ e.stopPropagation(); e.preventDefault(); startMoveRun(pageState, run, e); });
        resizeHandle.addEventListener('mousedown', (e: any)=>{ e.stopPropagation(); e.preventDefault(); startResizeRun(pageState, run, e); });
 
        // mousedown-then-mouseup with negligible movement = click-to-edit.
        // mousedown-then-drag = move the run, without entering edit mode.
        span.addEventListener('mousedown', (e: any)=>{
          if(span.isContentEditable) return; // already editing: let native caret placement happen
          e.preventDefault();
          e.stopPropagation();
          selectRun(pageState, run);
          const startX=e.clientX, startY=e.clientY;
          let dragging=false;
          const origLeft=run.left, origTop=run.top;
          function onMove(ev: any){
            const dx=ev.clientX-startX, dy=ev.clientY-startY;
            if(!dragging && (Math.abs(dx)>4 || Math.abs(dy)>4)){
              dragging=true; span.classList.add('dragging');
            }
            if(dragging){
              run.left = origLeft+dx; run.top = origTop+dy;
              span.style.left=run.left+'px'; span.style.top=run.top+'px';
              syncChrome(run);
            }
          }
          function onUp(){
            window.removeEventListener('mousemove',onMove);
            window.removeEventListener('mouseup',onUp);
            span.classList.remove('dragging');
            if(!dragging){ enterEditMode(pageState, run); }
            else {
              const finalLeft=run.left, finalTop=run.top;
              pushUndo(()=>{
                run.left=origLeft; run.top=origTop;
                span.style.left=origLeft+'px'; span.style.top=origTop+'px';
                syncChrome(run);
              });
            }
          }
          window.addEventListener('mousemove',onMove);
          window.addEventListener('mouseup',onUp);
        });
        
        span.addEventListener('blur', ()=> exitEditMode(pageState, run));
        span.addEventListener('keydown', (e)=>{
          if(e.key==='Escape'){ span.blur(); }
          if(e.key==='Enter'){ e.preventDefault(); span.blur(); }
        });
        span.addEventListener('input', ()=> { reflowLine(pageState, run); syncChrome(run); });
      }

      function syncChrome(run: any){
        if(!run.chromeEl) return;
        run.chromeEl.style.left = run.left+'px';
        run.chromeEl.style.top = run.top+'px';
        run.chromeEl.style.width = run.width+'px';
        run.chromeEl.style.height = (run.height||run.fontSize)+'px';
      }

      let selectedRun: any = null;
      function selectRun(pageState: any, run: any){
        if(selectedRun && selectedRun!==run) deselectRun(selectedRun);
        selectedRun = run;
        run.chromeEl.classList.add('visible');
      }
      
      function deselectRun(run: any){
        if(run && run.chromeEl) run.chromeEl.classList.remove('visible');
        if(selectedRun===run) selectedRun=null;
      }
      
      function startMoveRun(pageState: any, run: any, e: any){
        const startX=e.clientX, startY=e.clientY, origLeft=run.left, origTop=run.top;
        let moved=false;
        function onMove(ev: any){
          run.left = origLeft + (ev.clientX-startX);
          run.top = origTop + (ev.clientY-startY);
          run.el.style.left = run.left+'px';
          run.el.style.top = run.top+'px';
          moved=true;
          syncChrome(run);
        }
        function onUp(){
          window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp);
          if(moved){
            pushUndo(()=>{
              run.left=origLeft; run.top=origTop;
              run.el.style.left=origLeft+'px'; run.el.style.top=origTop+'px';
              syncChrome(run);
            });
          }
        }
        window.addEventListener('mousemove',onMove);
        window.addEventListener('mouseup',onUp);
      }
      
      function startResizeRun(pageState: any, run: any, e: any){
        const startX=e.clientX, startY=e.clientY, startFont=run.fontSize, startWidth=run.width, startHeight=run.height;
        let changed=false;
        function onMove(ev: any){
          const dx=ev.clientX-startX, dy=ev.clientY-startY;
          const drive = Math.abs(dx)>Math.abs(dy) ? dx : dy;
          const newFont = Math.max(4, startFont + drive*0.6);
          const ratio = newFont/startFont;
          run.fontSize = newFont;
          run.height = newFont;
          run.el.style.fontSize = newFont+'px';
          run.width = Math.max(6, startWidth*ratio);
          run.el.style.minWidth = run.width+'px';
          changed=true;
          syncChrome(run);
        }
        function onUp(){
          window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp);
          run.width = measureNaturalWidth(run.el);
          syncChrome(run);
          if(changed){
            pushUndo(()=>{
              run.fontSize=startFont; run.height=startHeight; run.width=startWidth;
              run.el.style.fontSize=startFont+'px'; run.el.style.minWidth=startWidth+'px';
              syncChrome(run);
            });
          }
        }
        window.addEventListener('mousemove',onMove);
        window.addEventListener('mouseup',onUp);
      }

      function styleRun(span: any, run: any){
        span.style.left = run.left+'px';
        span.style.top = run.top+'px';
        span.style.fontSize = run.fontSize+'px';
        span.style.color = run.color;
        span.style.fontFamily = run.cssFamily;
        span.style.fontWeight = run.bold ? '700':'400';
        span.style.fontStyle = run.italic ? 'italic':'normal';
        span.style.transform = run.angleRad ? `rotate(${run.angleRad}rad)` : '';
        span.style.minWidth = run.width+'px';
      }

      function enterEditMode(pageState: any, run: any){
        document.querySelectorAll('.run.editing').forEach((r: any)=>{ if(r!==run.el) r.blur(); });
        selectRun(pageState, run);
        const lineRuns = pageState.runs.filter((r: any) => !r.deleted && Math.abs(r.top - run.top) < Math.max(3, run.height*0.3));
        run._editSnapshot = {
          text: run.text,
          width: run.width,
          deleted: !!run.deleted,
          lineSnapshot: lineRuns.map((r: any)=>({run:r, left:r.left}))
        };
        run.el.contentEditable = 'true';
        run.el.classList.add('editing');
        run.el.focus();
        const sel = window.getSelection();
        if(sel && sel.rangeCount===0){
          const range = document.createRange();
          range.selectNodeContents(run.el); range.collapse(false);
          sel.removeAllRanges(); sel.addRange(range);
        }
      }
      
      function exitEditMode(pageState: any, run: any){
        run.el.contentEditable = 'false';
        run.el.classList.remove('editing');
        const newText = run.el.textContent;
        const before = run._editSnapshot;
        run.text = newText;
        if(run.text.trim()===''){
          run.el.style.display='none';
          run.deleted = true;
        } else if(run.deleted){
          run.deleted = false;
          run.el.style.display='';
        }
        if(before && before.text !== run.text){
          pushUndo(()=>{
            run.text = before.text;
            run.el.textContent = before.text;
            run.deleted = before.deleted;
            run.el.style.display = before.deleted ? 'none':'';
            run.width = before.width;
            run.el.style.minWidth = before.width+'px';
            before.lineSnapshot.forEach((s: any)=>{ s.run.left = s.left; if(s.run.el) s.run.el.style.left = s.left+'px'; syncChrome(s.run); });
            syncChrome(run);
          });
        }
        run._editSnapshot = null;
      }

      function reflowLine(pageState: any, changedRun: any){
        const measured = measureNaturalWidth(changedRun.el);
        const delta = measured - changedRun.width;
        if(Math.abs(delta) < 0.5) return;

        const lineRuns = pageState.runs
          .filter((r: any) => !r.deleted && Math.abs(r.top - changedRun.top) < Math.max(3, changedRun.height*0.3))
          .sort((a: any, b: any)=>a.left-b.left);

        const idx = lineRuns.indexOf(changedRun);
        changedRun.width = measured;
        if(idx===-1) return;
        for(let i=idx+1;i<lineRuns.length;i++){
          lineRuns[i].left += delta;
          lineRuns[i].el.style.left = lineRuns[i].left+'px';
        }
      }
      
      function measureNaturalWidth(elm: any){
        const r = elm.getBoundingClientRect();
        return r.width;
      }

      /* ============================================================
         INSERT NEW TEXT
         ============================================================ */
      let insertTextMode = false;
      el('btnInsertText').onclick = ()=>{
        insertTextMode = !insertTextMode;
        el('btnInsertText').classList.toggle('active', insertTextMode);
        document.querySelectorAll('.page-shell').forEach((s: any)=>s.style.cursor = insertTextMode?'text':'');
      };
      
      document.getElementById('pageStack')!.addEventListener('click', (e: any)=>{
        if(!insertTextMode) return;
        const shell = e.target.closest('.page-shell');
        if(!shell) return;
        const pageNum = parseInt(shell.id.replace('page-shell-',''));
        const pageState = pages[pageNum-1];
        const rect = shell.getBoundingClientRect();
        const left = e.clientX - rect.left, top = e.clientY - rect.top;
        const run = {
          id:'new'+pageNum+'_'+pageState.runs.length,
          text:'New text', left, top: top-14, width:70, height:18,
          fontSize:16, angleRad:0, color:'rgb(20,20,20)',
          generic:'sans', bold:false, italic:false, cssFamily:"'Helvetica','Arial',sans-serif",
          origLeft:left, origTop:top-14, origWidth:70, isNew:true
        };
        pageState.runs.push(run);
        mountRun(pageState, run);
        pushUndo(()=>{
          if((run as any).el) (run as any).el.remove();
          if((run as any).chromeEl) ((run as any).chromeEl).remove();
          const idx = pageState.runs.indexOf(run);
          if(idx>-1) pageState.runs.splice(idx,1);
          if(selectedRun===run) selectedRun=null;
        });
        insertTextMode = false;
        el('btnInsertText').classList.remove('active');
        document.querySelectorAll('.page-shell').forEach((s: any)=>s.style.cursor = '');
        setTimeout(()=>enterEditMode(pageState, run), 0);
        const sel = window.getSelection() as any; const range=document.createRange();
        range.selectNodeContents((run as any).el); sel.removeAllRanges(); sel.addRange(range);
      });

      /* ============================================================
         IMAGES — select, move, resize, rotate, replace, delete
         ============================================================ */
      function mountImage(pageState: any, im: any){
        const box = document.createElement('div');
        box.className='img-obj';
        box.style.left=im.left+'px'; box.style.top=im.top+'px';
        box.style.width=im.width+'px'; box.style.height=im.height+'px';
        box.style.transform = im.rotation? `rotate(${im.rotation}deg)`:'';
        box.dataset.imgId = im.id;
        const imgEl = document.createElement('img'); imgEl.src = im.dataUrl;
        box.appendChild(imgEl);
        pageState.imageLayerEl.appendChild(box);
        im.el = box;

        box.addEventListener('mousedown', (e: any)=>{
          if(e.target.classList.contains('handle')) return;
          e.stopPropagation();
          selectImage(pageState, im);
          startDrag(pageState, im, e);
        });
      }

      function selectImage(pageState: any, im: any){
        document.querySelectorAll('.img-obj.selected').forEach(b=>clearImageChrome(b));
        activeImgObj = im;
        im.el.classList.add('selected');
        addImageChrome(pageState, im);
      }
      
      document.getElementById('pageStack')!.addEventListener('mousedown', (e: any)=>{
        if(!e.target.closest('.img-obj')){
          document.querySelectorAll('.img-obj.selected').forEach(b=>clearImageChrome(b));
          activeImgObj = null;
        }
        if(!e.target.closest('.run') && !e.target.closest('.run-chrome') && selectedRun){
          deselectRun(selectedRun);
        }
      });

      function clearImageChrome(boxEl: any){
        boxEl.classList.remove('selected');
        boxEl.querySelectorAll('.handle,.img-toolbar').forEach((n: any)=>n.remove());
      }
      
      function addImageChrome(pageState: any, im: any){
        ['nw','ne','sw','se'].forEach(pos=>{
          const h = document.createElement('div'); h.className='handle '+pos;
          h.addEventListener('mousedown', (e: any)=>{ e.stopPropagation(); startResize(pageState, im, pos, e); });
          im.el.appendChild(h);
        });
        const rot = document.createElement('div'); rot.className='handle rot';
        rot.addEventListener('mousedown',(e: any)=>{ e.stopPropagation(); startRotate(pageState, im, e); });
        im.el.appendChild(rot);

        const bar = document.createElement('div'); bar.className='img-toolbar';
        bar.innerHTML = `<button data-a="replace">Replace</button><button data-a="delete">Delete</button>`;
        (bar.querySelector('[data-a="replace"]') as any).onclick=(e: any)=>{ e.stopPropagation(); replaceImage(im); };
        (bar.querySelector('[data-a="delete"]') as any).onclick=(e: any)=>{ e.stopPropagation(); deleteImage(pageState, im); };
        im.el.appendChild(bar);
      }
      
      function startDrag(pageState: any, im: any, e: any){
        const sx=e.clientX, sy=e.clientY, ol=im.left, ot=im.top;
        let moved=false;
        function onMove(ev: any){
          im.left = ol + (ev.clientX-sx); im.top = ot + (ev.clientY-sy);
          im.el.style.left=im.left+'px'; im.el.style.top=im.top+'px';
          moved=true;
        }
        function onUp(){
          window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp);
          if(moved){
            pushUndo(()=>{ im.left=ol; im.top=ot; im.el.style.left=ol+'px'; im.el.style.top=ot+'px'; });
          }
        }
        window.addEventListener('mousemove',onMove); window.addEventListener('mouseup',onUp);
      }
      
      function startResize(pageState: any, im: any, pos: string, e: any){
        const sx=e.clientX, sy=e.clientY, ow=im.width, oh=im.height, ol=im.left, ot=im.top;
        let changed=false;
        function onMove(ev: any){
          const dx=ev.clientX-sx, dy=ev.clientY-sy;
          if(pos==='se'){ im.width=Math.max(10,ow+dx); im.height=Math.max(10,oh+dy); }
          if(pos==='ne'){ im.width=Math.max(10,ow+dx); im.height=Math.max(10,oh-dy); im.top=ot+dy; }
          if(pos==='sw'){ im.width=Math.max(10,ow-dx); im.height=Math.max(10,oh+dy); im.left=ol+dx; }
          if(pos==='nw'){ im.width=Math.max(10,ow-dx); im.height=Math.max(10,oh-dy); im.left=ol+dx; im.top=ot+dy; }
          im.el.style.width=im.width+'px'; im.el.style.height=im.height+'px';
          im.el.style.left=im.left+'px'; im.el.style.top=im.top+'px';
          changed=true;
        }
        function onUp(){
          window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp);
          if(changed){
            pushUndo(()=>{
              im.width=ow; im.height=oh; im.left=ol; im.top=ot;
              im.el.style.width=ow+'px'; im.el.style.height=oh+'px';
              im.el.style.left=ol+'px'; im.el.style.top=ot+'px';
            });
          }
        }
        window.addEventListener('mousemove',onMove); window.addEventListener('mouseup',onUp);
      }
      
      function startRotate(pageState: any, im: any, e: any){
        const rect = im.el.getBoundingClientRect();
        const cx = rect.left+rect.width/2, cy = rect.top+rect.height/2;
        const origRotation = im.rotation||0;
        let changed=false;
        function onMove(ev: any){
          const ang = Math.atan2(ev.clientY-cy, ev.clientX-cx)*180/Math.PI + 90;
          im.rotation = Math.round(ang);
          im.el.style.transform = `rotate(${im.rotation}deg)`;
          changed=true;
        }
        function onUp(){
          window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp);
          if(changed){
            pushUndo(()=>{ im.rotation=origRotation; im.el.style.transform = origRotation? `rotate(${origRotation}deg)`:''; });
          }
        }
        window.addEventListener('mousemove',onMove); window.addEventListener('mouseup',onUp);
      }
      
      function deleteImage(pageState: any, im: any){
        im.deleted = true;
        im.el.remove();
        activeImgObj = null;
        pushUndo(()=>{
          im.deleted = false;
          pageState.imageLayerEl.appendChild(im.el);
        });
      }
      
      function replaceImage(im: any){
        const input = el('imageReplaceInput');
        input.onchange = ()=>{
          const f = input.files[0]; if(!f) return;
          const reader = new FileReader();
          const oldUrl = im.dataUrl;
          reader.onload = ()=>{
            im.dataUrl = reader.result; im.el.querySelector('img').src = reader.result;
            pushUndo(()=>{ im.dataUrl = oldUrl; im.el.querySelector('img').src = oldUrl; });
          };
          reader.readAsDataURL(f);
          input.value='';
        };
        input.click();
      }

      /* ============================================================
         INSERT IMAGE (explicit)
         ============================================================ */
      el('btnInsertImage').onclick = ()=>{
        if(!pages.length) return;
        const input = el('imageReplaceInput');
        input.onchange = ()=>{
          const f = input.files[0]; if(!f) return;
          const reader = new FileReader();
          reader.onload = ()=>{
            const pageState = pages[0];
            const im = {id:'newimg'+Date.now(), left:60, top:60, width:160, height:120, rotation:0, dataUrl:reader.result as string, deleted:false};
            pageState.images.push(im);
            mountImage(pageState, im);
            selectImage(pageState, im);
            pushUndo(()=>{
              im.deleted = true;
              if((im as any).el) (im as any).el.remove();
              const idx = pageState.images.indexOf(im);
              if(idx>-1) pageState.images.splice(idx,1);
              if(activeImgObj===im) activeImgObj=null;
            });
          };
          reader.readAsDataURL(f);
          input.value='';
        };
        input.click();
      };

      /* ============================================================
         ZOOM
         ============================================================ */
      el('btnZoomIn').onclick = ()=>rezoom(scale+0.15);
      el('btnZoomOut').onclick = ()=>rezoom(Math.max(0.4,scale-0.15));
      
      async function rezoom(newScale: number){
        scale = newScale;
        undoStack = [];
        updateUndoButton();
        el('zoomLabel').textContent = Math.round(scale/1.5*100)+'%';
        const stack = el('pageStack');
        stack.innerHTML='';
        const oldPages = pages;
        pages = new Array(pdfjsDoc.numPages).fill(null);
        showLoading('Adjusting zoom…');
        for(let i=1;i<=pdfjsDoc.numPages;i++){
          await renderPage(i);
          if(oldPages[i-1]){
            const prevRuns = oldPages[i-1].runs.filter((r: any)=>!r.deleted);
            prevRuns.forEach((pr: any,idx: number)=>{
              const nr = pages[i-1].runs[idx];
              if(nr && pr.text !== undefined){ nr.text = pr.text; if(nr.el) nr.el.textContent = pr.text; }
            });
          }
        }
        hideLoading();
      }

      /* ============================================================
         EXPORT — rebuild PDF with real text + image objects
         ============================================================ */
      el('btnExport').onclick = exportPdf;
      
      async function exportPdf(){
        showLoading('Building exported PDF…');
        try{
          const outDoc = await PDFDocument.create();
          const stdFontObjs: any = {};
          
          async function stdFont(generic: string, bold: boolean, italic: boolean){
            const key = standardFontFor(generic,bold,italic);
            if(!stdFontObjs[key]) stdFontObjs[key] = await outDoc.embedFont(key);
            return stdFontObjs[key];
          }

          for(const pageState of pages){
            const {viewport} = pageState;
            const pageWpt = viewport.width/scale;
            const pageHpt = viewport.height/scale;
            const pdfPage = outDoc.addPage([pageWpt, pageHpt]);

            // background raster (graphics with text & images erased)
            const bgPng = await outDoc.embedPng(pageState.canvas.toDataURL('image/png'));
            pdfPage.drawImage(bgPng, {x:0, y:0, width:pageWpt, height:pageHpt});

            // images (as real image objects, current edited transform)
            for(const im of pageState.images){
              if(im.deleted) continue;
              let embedded;
              try{
                embedded = im.dataUrl.startsWith('data:image/png')
                  ? await outDoc.embedPng(im.dataUrl)
                  : await outDoc.embedJpg(im.dataUrl);
              }catch(e){
                try{ embedded = await outDoc.embedPng(im.dataUrl); }catch(e2){ continue; }
              }
              const x = im.left/scale, yTop = im.top/scale, w = im.width/scale, h = im.height/scale;
              const y = pageHpt - yTop - h;
              pdfPage.drawImage(embedded, {
                x, y, width:w, height:h,
                rotate: degrees(-(im.rotation||0))
              });
            }

            // text (real, searchable, editable objects)
            for(const run of pageState.runs){
              if(run.deleted || !run.text || !run.text.trim()) continue;
              const font = await stdFont(run.generic, run.bold, run.italic);
              const x = run.left/scale;
              const fontSizePt = run.fontSize/scale;
              const topPt = run.top/scale;
              const baselinePt = topPt + fontSizePt*0.8;
              const y = pageHpt - baselinePt;
              let c = {r:0.08,g:0.08,b:0.08};
              const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(run.color);
              if(m) c = {r:+m[1]/255, g:+m[2]/255, b:+m[3]/255};
              try{
                pdfPage.drawText(run.text, {
                  x, y, size: Math.max(fontSizePt,1), font,
                  color: rgb(c.r,c.g,c.b),
                  rotate: degrees(run.angleRad ? -run.angleRad*180/Math.PI : 0)
                });
              }catch(e){ /* skip glyphs unsupported by standard font */ }
            }
          }

          const bytes = await outDoc.save();
          const blob = new Blob([bytes], {type:'application/pdf'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'edited.pdf';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(()=>URL.revokeObjectURL(url), 4000);
          setStatus('Exported edited.pdf');
        }catch(err: any){
          console.error(err);
          alert('Export failed: '+err.message);
        }finally{
          hideLoading();
        }
      }
    };

    initEditor();
  }, []);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        
        :root {
          --ink: #0f172a;
          --paper: #f8fafc;
          --panel: #ffffff;
          --line: #e2e8f0;
          --accent: #4f46e5;
          --accent-hover: #4338ca;
          --accent-soft: #eeebff;
          --warn: #ef4444;
          --mono: 'JetBrains Mono', 'IBM Plex Mono', Consolas, monospace;
          --sans: 'Inter', -apple-system, sans-serif;
        }
        * { box-sizing: border-box; }
        body {
          font-family: var(--sans);
          background: var(--paper);
          color: var(--ink);
          display: flex;
          flex-direction: column;
          height: 100vh;
          overflow: hidden;
        }
        #topbar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 24px;
          background: rgba(15, 23, 42, 0.96);
          backdrop-filter: blur(12px);
          color: #f8fafc;
          flex-shrink: 0;
          z-index: 50;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        #topbar .brand {
          font-family: var(--mono);
          font-size: 13px;
          font-weight: 600;
          letter-spacing: .12em;
          text-transform: uppercase;
          color: #818cf8;
          margin-right: 16px;
          white-space: nowrap;
        }
        .tbtn {
          background: rgba(255, 255, 255, 0.06);
          color: #e2e8f0;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 8px 14px;
          font-size: 13px;
          font-weight: 500;
          font-family: var(--sans);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
          transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .tbtn:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.2);
          transform: translateY(-1px);
        }
        .tbtn:active {
          transform: translateY(0);
        }
        .tbtn.primary {
          background: var(--accent);
          border-color: var(--accent);
          color: #ffffff;
        }
        .tbtn.primary:hover {
          background: var(--accent-hover);
          border-color: var(--accent-hover);
          box-shadow: 0 0 12px rgba(79, 70, 229, 0.4);
        }
        .tbtn:disabled {
          opacity: .35;
          cursor: not-allowed;
          transform: none !important;
          box-shadow: none !important;
        }
        .tbtn.active {
          background: var(--accent);
          border-color: var(--accent);
          color: #ffffff;
        }
        #topbar .sep { width: 1px; align-self: stretch; background: rgba(255, 255, 255, 0.1); margin: 0 4px; }
        #topbar .spacer { flex: 1; }
        #pageIndicator { font-family: var(--mono); font-size: 12px; color: #94a3b8; white-space: nowrap; }
        #status {
          font-family: var(--mono);
          font-size: 11px;
          color: #64748b;
          white-space: nowrap;
          max-width: 280px;
          overflow: hidden;
          text-overflow: ellipsis;
          background: rgba(255, 255, 255, 0.03);
          padding: 4px 10px;
          border-radius: 6px;
        }
        
        #body { flex: 1; display: flex; overflow: hidden; }
        #sidebar {
          width: 180px;
          flex-shrink: 0;
          background: #ffffff;
          border-right: 1px solid var(--line);
          overflow-y: auto;
          padding: 16px;
          box-shadow: 2px 0 10px rgba(0, 0, 0, 0.02);
        }
        #sidebar .thumb {
          border: 2px solid transparent;
          border-radius: 8px;
          margin-bottom: 16px;
          cursor: pointer;
          overflow: hidden;
          background: #fff;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
          transition: all 0.2s ease;
        }
        #sidebar .thumb:hover {
          transform: scale(1.03);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.08);
        }
        #sidebar .thumb.active {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft), 0 4px 6px -1px rgba(0,0,0,0.1);
        }
        #sidebar .thumb img { width: 100%; display: block; }
        #sidebar .thumb .num {
          font-family: var(--mono);
          font-size: 11px;
          font-weight: 500;
          text-align: center;
          padding: 6px 0;
          color: #64748b;
          background: #f8fafc;
          border-top: 1px solid #f1f5f9;
        }
        
        #canvasWrap {
          flex: 1;
          overflow: auto;
          display: flex;
          justify-content: center;
          padding: 48px 32px;
          position: relative;
          background: #f1f5f9;
          background-size: 16px 16px;
          background-image: linear-gradient(to right, rgba(0, 0, 0, 0.03) 1px, transparent 1px),
                            linear-gradient(to bottom, rgba(0, 0, 0, 0.03) 1px, transparent 1px);
        }
        #pageStack { position: relative; }
        .page-shell {
          position: relative;
          background: #fff;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
          margin-bottom: 24px;
          border-radius: 4px;
          overflow: visible;
        }
        .page-shell canvas { display: block; }
        
        .text-layer {
          position: absolute;
          top: 0;
          left: 0;
          pointer-events: none;
          z-index: 15;
          width: 100%;
          height: 100%;
        }
        .image-layer {
          position: absolute;
          top: 0;
          left: 0;
          pointer-events: none;
          z-index: 10;
          width: 100%;
          height: 100%;
        }
        
        .run {
          position: absolute;
          white-space: pre;
          transform-origin: 0 0;
          outline: none;
          cursor: text;
          padding: 0; margin: 0; border: none;
          line-height: 1;
          -webkit-user-select: text;
          caret-color: var(--accent);
          pointer-events: auto;
        }
        .run:hover { outline: 1px dashed rgba(79, 70, 229, 0.5); }
        .run.editing { background: transparent; box-shadow: 0 0 0 1.5px var(--accent); }
        .run.new-text { background: transparent; }
        .run.dragging { opacity: .75; background: rgba(79, 70, 229, 0.12); }
        
        .run-chrome { position: absolute; display: none; pointer-events: none; box-shadow: 0 0 0 1.5px var(--accent); }
        .run-chrome.visible { display: block; }
        .run-chrome .handle {
          position: absolute;
          pointer-events: auto;
          background: #fff;
          border: 2px solid var(--accent);
          border-radius: 50%;
          width: 10px;
          height: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.15);
          transition: transform 0.1s ease;
        }
        .run-chrome .handle:hover {
          transform: scale(1.3);
        }
        .run-chrome .handle.resize { right: -6px; bottom: -6px; cursor: nwse-resize; }
        .run-chrome .handle.move { left: -6px; top: -6px; cursor: move; border-radius: 3px; background: var(--accent); }
        
        .img-obj {
          position: absolute;
          cursor: move;
          pointer-events: auto;
          transition: box-shadow 0.15s ease;
        }
        .img-obj img { width: 100%; height: 100%; display: block; pointer-events: none; user-select: none; }
        .img-obj.selected {
          outline: 2px solid var(--accent);
          box-shadow: 0 10px 25px rgba(0,0,0,0.15);
          z-index: 100;
        }
        .img-obj .handle {
          position: absolute;
          width: 10px;
          height: 10px;
          background: #fff;
          border: 2px solid var(--accent);
          border-radius: 50%;
          box-shadow: 0 2px 4px rgba(0,0,0,0.15);
          transition: transform 0.1s ease;
          pointer-events: auto;
        }
        .img-obj .handle:hover {
          transform: scale(1.3);
        }
        .img-obj .handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
        .img-obj .handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
        .img-obj .handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
        .img-obj .handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
        .img-obj .handle.rot {
          top: -26px;
          left: 50%;
          transform: translateX(-50%);
          cursor: grab;
          background: var(--warn);
          border-color: var(--warn);
        }
        .img-obj .handle.rot:hover {
          transform: translateX(-50%) scale(1.3);
        }
        .img-toolbar {
          position: absolute;
          top: -42px;
          left: 0;
          display: flex;
          gap: 4px;
          background: #0f172a;
          border-radius: 8px;
          padding: 4px;
          box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3);
          border: 1px solid rgba(255, 255, 255, 0.08);
          animation: floatIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes floatIn {
          from { transform: translateY(4px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .img-toolbar button {
          background: none;
          border: none;
          color: #f1f5f9;
          font-size: 11px;
          font-weight: 500;
          padding: 5px 9px;
          border-radius: 5px;
          cursor: pointer;
          font-family: var(--sans);
          transition: all 0.15s ease;
        }
        .img-toolbar button:hover {
          background: rgba(255, 255, 255, 0.1);
        }
        
        #dropzone {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          gap: 20px;
          color: #64748b;
        }
        #dropzone .card {
          border: 2px dashed #cbd5e1;
          border-radius: 16px;
          padding: 64px 80px;
          text-align: center;
          background: #ffffff;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.02), 0 8px 10px -6px rgba(0, 0, 0, 0.02);
          max-width: 580px;
          transition: all 0.25s ease;
        }
        #dropzone .card:hover {
          border-color: var(--accent);
          transform: translateY(-2px);
          box-shadow: 0 20px 25px -5px rgba(0,0,0,0.05);
        }
        #dropzone .card.drag {
          border-color: var(--accent);
          background: var(--accent-soft);
          transform: scale(1.02);
        }
        #dropzone h1 {
          font-size: 20px;
          font-weight: 700;
          margin: 0 0 10px;
          color: var(--ink);
          letter-spacing: -0.02em;
        }
        #dropzone p {
          font-size: 14px;
          line-height: 1.6;
          margin: 0 0 24px;
          color: #64748b;
        }
        #dropzone input[type=file] { display: none; }
        
        #loadingOverlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.7);
          backdrop-filter: blur(6px);
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 200;
          flex-direction: column;
          gap: 16px;
          color: #fff;
        }
        #loadingOverlay .spin {
          width: 36px;
          height: 36px;
          border: 3.5px solid rgba(255,255,255,0.2);
          border-top-color: #818cf8;
          border-radius: 50%;
          animation: spin .7s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        #loadingOverlay .msg {
          font-family: var(--mono);
          font-size: 13px;
          font-weight: 500;
          letter-spacing: .06em;
          color: #cbd5e1;
        }
        
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 6px; border: 2px solid var(--paper); }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      `}</style>

      {/* CDN Scripts */}
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js" strategy="beforeInteractive" />
      <Script src="https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js" strategy="beforeInteractive" />

      <div id="topbar">
        <div className="brand">In-Place PDF Editor</div>
        <button className="tbtn" id="btnOpen">Open PDF</button>
        <div className="sep"></div>
        <button className="tbtn" id="btnInsertText" disabled>+ Text</button>
        <button className="tbtn" id="btnInsertImage" disabled>+ Image</button>
        <div className="sep"></div>
        <button className="tbtn" id="btnZoomOut" disabled>&minus;</button>
        <span id="zoomLabel" style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: '#c7cbd4' }}>100%</span>
        <button className="tbtn" id="btnZoomIn" disabled>+</button>
        <div className="sep"></div>
        <button className="tbtn" id="btnUndo" disabled>&#8630; Undo</button>
        <div className="spacer"></div>
        <span id="status"></span>
        <span id="pageIndicator"></span>
        <button className="tbtn primary" id="btnExport" disabled>Export PDF</button>
        <input type="file" id="fileInput" accept="application/pdf" style={{ display: 'none' }} />
        <input type="file" id="imageReplaceInput" accept="image/*" style={{ display: 'none' }} />
      </div>

      <div id="body">
        <div id="sidebar" style={{ display: 'none' }}></div>
        <div id="canvasWrap">
          <div id="dropzone">
            <div className="card" id="dropCard">
              <h1>Open a PDF to start editing in place</h1>
              <p>Click existing text and it becomes editable exactly where it sits — same font, size, color and position. Scanned pages are OCR&apos;d automatically and reconstructed into editable text.</p>
              <button className="tbtn primary" id="btnOpen2">Choose file&hellip;</button>
            </div>
          </div>
          <div id="pageStack" style={{ display: 'none' }}></div>
        </div>
      </div>

      <div id="loadingOverlay">
        <div className="spin"></div>
        <div className="msg" id="loadingMsg">Working&hellip;</div>
      </div>
    </>
  );
}
