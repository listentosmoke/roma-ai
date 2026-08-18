// Inspector interpretation (fast path): turn structured detections into a basic
// scene label and ONE short grounded sentence. Pure and template-based.
//
// PLACEHOLDER: this stands in for a very small vision/multimodal model (e.g.
// Moondream, SmolVLM, or Haiku with a frame). Swap by replacing interpretScene()
// behind the same signature — the Inspector orchestrator only consumes
// { sceneLabel, summary }. It must stay SHORT and grounded in detections; the
// main agent does the higher-level reasoning, not this.

const SCENE_CUES = [
  { scene: 'workshop / tools', cues: ['toolbox', 'wrench', 'adjustable wrench', 'hammer', 'claw hammer', 'screwdriver', 'pliers', 'drill', 'tape measure', 'saw'] },
  { scene: 'desk / office', cues: ['laptop', 'keyboard', 'mouse', 'monitor', 'tv', 'book'] },
  { scene: 'kitchen', cues: ['cup', 'bowl', 'fork', 'knife', 'spoon', 'microwave', 'oven', 'refrigerator', 'sink', 'bottle', 'wine glass'] },
  { scene: 'living room', cues: ['couch', 'sofa', 'chair', 'potted plant', 'remote', 'bed'] },
  { scene: 'outdoors / street', cues: ['car', 'truck', 'bicycle', 'traffic light', 'stop sign', 'bench'] },
];

export function classifyScene(objects) {
  const labels = new Set((objects ?? []).filter((o) => o.visibility === 'visible').map((o) => o.label));
  if (!labels.size) return 'no scene detected';
  let best = 'indoor scene';
  let bestHits = 0;
  for (const { scene, cues } of SCENE_CUES) {
    const hits = cues.filter((cue) => labels.has(cue)).length;
    if (hits > bestHits) { best = scene; bestHits = hits; }
  }
  return best;
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function interpretScene({ objects = [], people = [], sceneLabel = '' } = {}) {
  const visible = objects.filter((o) => o.visibility === 'visible');
  const named = people.filter((p) => p.identity).map((p) => p.identity);
  const unknownCount = people.length - named.length;

  let who;
  if (!people.length) who = 'Nobody is visible';
  else if (people.length === 1) who = named.length ? `${named[0]} is present` : 'One unidentified person is present';
  else {
    const parts = [...named];
    if (unknownCount > 0) parts.push(`${unknownCount} unidentified`);
    who = `${people.length} people are present (${parts.join(', ')})`;
  }

  if (!visible.length) return `${who}; no objects detected.`;

  const topLabels = [...new Set(visible.map((o) => o.label))].slice(0, 5);
  const extra = visible.length - topLabels.length;
  const what = `${listPhrase(topLabels)}${extra > 0 ? ` (+${extra} more)` : ''} in view`;
  const generic = !sceneLabel || sceneLabel === 'no scene detected' || sceneLabel === 'indoor scene';
  const where = generic ? '' : ` in a ${sceneLabel.split(' / ')[0]} setting`;
  return `${who}${where}, with ${what}.`;
}
