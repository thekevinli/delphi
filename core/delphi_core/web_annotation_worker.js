/* This entry point runs only in the trusted reader's dedicated worker. */
let current = null, pinned = null, generation = 0, resolving = 0, originals = [];
onmessage = async ({ data }) => {
  const send = message => postMessage({ ...message, epoch: data.epoch });
  try {
    if (data.type === "invalidate") {
      current = null;
      generation++;
    }
    else if (data.type === "capture") {
      // The page as the frame read it when the reader asked, with the selection
      // measured in that same reading. A Reply keeps it as the question's evidence.
      const snapshot = await DelphiAnnotations.index(data.texts, current);
      const anchor = DelphiAnnotations.anchor(snapshot, data.start, data.end);
      const text = snapshot.text.slice(data.start, data.end);
      if (data.pin)
        pinned = { index: snapshot, quote: text };
      send({ type: "captured", request: data.request, anchor, text });
    }
    else if (data.type === "evidence") {
      const source = data.quote && pinned?.quote === data.quote ? pinned.index : current;
      if (!source || !source.text.trim())
        throw Error("The page is not ready to read");
      send({ type: "evidence", request: data.request, revision: source.revision, texts: source.blocks.map(b => b.text) });
    }
    else if (data.type === "index") {
      const ticket = ++generation;
      const next = await DelphiAnnotations.index(data.texts, current);
      if (ticket !== generation)
        return;
      current = next;
      send({ type: "indexed", generation: data.generation, revision: next.revision });
    }
    else if (data.type === "resolve" && current && data.revision === current.revision) {
      originals = data.annotations;
      if (!Array.isArray(originals) || originals.length > 10000)
        throw Error("Too many annotations");
      const source = current, ticket = ++resolving, epoch = generation;
      const complete = data.complete && !DelphiAnnotations.walled(source);
      const results = [];
      const deadline = performance.now() + 100;
      let slice = performance.now();
      for (const a of originals) {
        results.push({ id: a.id, ...DelphiAnnotations.resolve(source, a, complete, Math.min(deadline, performance.now() + 20)) });
        if (performance.now() - slice > 4) {
          await new Promise(resolve => setTimeout(resolve, 0));
          slice = performance.now();
          if (ticket !== resolving || epoch !== generation)
            return;
        }
      }
      if (ticket === resolving && epoch === generation)
        send({ type: "placements", generation: data.generation, revision: source.revision, results });
    }
  }
  catch (error) {
    send({ type: "error", message: String(error), request: data.request });
  }
};
