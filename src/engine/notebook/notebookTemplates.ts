import { NotebookData } from '../../types/notebook';
import { uid } from '../spreadsheet/workbookOps';

export type NotebookTemplateId = 'blank' | 'grad' | 'attention' | 'data';

export interface NotebookTemplateMeta {
  id: NotebookTemplateId;
  name: string;
  subtitle: string;
}

export const NOTEBOOK_TEMPLATES: NotebookTemplateMeta[] = [
  { id: 'blank', name: 'Blank Notebook', subtitle: 'Clean Python 3 notebook with Markdown & Math' },
  {
    id: 'grad',
    name: 'Gradient Descent Math Lab',
    subtitle: 'KaTeX equations + runnable optimizer & loss convergence',
  },
  {
    id: 'attention',
    name: 'Transformer Attention Lab',
    subtitle: 'Scaled Dot-Product Attention from scratch with math & code',
  },
  {
    id: 'data',
    name: 'Data Exploration Lab',
    subtitle: 'Quick statistics, distributions & live variable inspector',
  },
];

export function createBlankNotebook(title = 'Untitled Notebook'): NotebookData {
  const now = Date.now();
  return {
    id: uid('nb'),
    title,
    kernelName: 'Python 3',
    createdAt: now,
    updatedAt: now,
    cells: [
      {
        id: uid('cell'),
        cell_type: 'markdown',
        source: `# ${title}\n\nWrite notes with inline math like $\\mathcal{L}(\\theta)$ or display equations, then press \`Shift+Enter\` to run Python cells.`,
      },
      {
        id: uid('cell'),
        cell_type: 'code',
        source: 'import math\nprint("Forma Lab kernel ready!", round(math.pi, 6))',
        execution_count: null,
        outputs: [],
      },
    ],
  };
}

function createGradientDescentLab(): NotebookData {
  const now = Date.now();
  return {
    id: uid('nb'),
    title: 'Gradient Descent & Optimization Lab',
    kernelName: 'Python 3',
    createdAt: now,
    updatedAt: now,
    cells: [
      {
        id: uid('cell'),
        cell_type: 'markdown',
        pinnedConcept: true,
        source: `# Gradient Descent & Convergence Mechanics

Given a smooth loss surface $\\mathcal{L}(\\theta)$, gradient descent iteratively updates parameters opposite the gradient:

$$\\theta_{t+1} = \\theta_t - \\eta \\nabla_\\theta \\mathcal{L}(\\theta_t)$$

For a convex quadratic $\\mathcal{L}(\\theta) = \\frac{1}{2}(\\theta - \\theta^*)^2 + c$, convergence requires $0 < \\eta < 2$. Try toggling **Study Mode** above to read this like a paper and collapse code cells to test your recall!`,
      },
      {
        id: uid('cell'),
        cell_type: 'code',
        source: `# Quadratic objective: L(w) = 0.5 * (w - 3.5)^2 + 1.0
theta_star = 3.5
lr = 0.25  # @slider 0.05..2.05 step=0.05
num_steps = 15  # @slider 5..40 step=1
w = -4.0

history = []
for step in range(num_steps):
    loss = 0.5 * (w - theta_star) ** 2 + 1.0
    grad = w - theta_star
    history.append((step, round(w, 4), round(loss, 5)))
    w = w - lr * grad

for step, val, loss in history[:6]:
    print(f"step={step:2d} | w={val:8.4f} | loss={loss:.5f}")
print(f"Final w = {w:.6f} (target = {theta_star})")`,
        execution_count: null,
        outputs: [],
      },
      {
        id: uid('cell'),
        cell_type: 'markdown',
        source: `## Visualize the Loss Curve

If \`matplotlib\` is installed in your selected Python environment, Forma Lab automatically hooks \`plt.show()\` and renders Retina plots inline below.`,
      },
      {
        id: uid('cell'),
        cell_type: 'code',
        source: `try:
    import matplotlib.pyplot as plt
    steps = [h[0] for h in history]
    losses = [h[2] for h in history]
    plt.figure(figsize=(6.5, 3.2))
    plt.plot(steps, losses, marker="o", linewidth=2, color="#7c3aed")
    plt.title("Gradient Descent Loss Convergence")
    plt.xlabel("Step")
    plt.ylabel("Loss L(w)")
    plt.grid(True, alpha=0.3)
    plt.show()
except ImportError:
    print("Install matplotlib to render inline plots — ASCII fallback:")
    for step, _, loss in history[::2]:
        bar = "#" * max(1, int(loss * 1.5))
        print(f"t={step:2d} | {bar} ({loss:.3f})")`,
        execution_count: null,
        outputs: [],
      },
    ],
  };
}

function createAttentionLab(): NotebookData {
  const now = Date.now();
  return {
    id: uid('nb'),
    title: 'Scaled Dot-Product Attention Lab',
    kernelName: 'Python 3',
    createdAt: now,
    updatedAt: now,
    cells: [
      {
        id: uid('cell'),
        cell_type: 'markdown',
        pinnedConcept: true,
        source: `# Scaled Dot-Product Attention

In Transformer architectures, attention routes information across tokens via Queries $Q$, Keys $K$, and Values $V$:

$$\\text{Attention}(Q, K, V) = \\text{softmax}\\!\\left(\\frac{Q K^\\top}{\\sqrt{d_k}}\\right) V$$

Dividing by $\\sqrt{d_k}$ keeps dot-product variance at $O(1)$ as embedding dimension $d_k$ grows, preventing softmax saturation and vanishing gradients.`,
      },
      {
        id: uid('cell'),
        cell_type: 'code',
        source: `import math

def dot(a, b):
    return sum(x * y for x, y in zip(a, b))

def softmax(xs):
    m = max(xs)
    exps = [math.exp(x - m) for x in xs]
    s = sum(exps)
    return [e / s for e in exps]

tokens = ["The", "cat", "sat"]
Q = [[1.0, 0.2, 0.5], [0.1, 1.2, 0.4], [0.3, 0.9, 1.1]]
K = [[1.0, 0.1, 0.4], [0.2, 1.1, 0.3], [0.2, 0.8, 1.2]]
V = [[1.0, 0.0], [0.0, 1.0], [0.5, 0.5]]

d_k = len(K[0])
temperature = 1.0  # @slider 0.1..3.0 step=0.05
weights = [
    softmax([dot(q, k) / (math.sqrt(d_k) * temperature) for k in K])
    for q in Q
]

for tok, w in zip(tokens, weights):
    formatted = "  ".join(f"{p:.3f}" for p in w)
    print(f"{tok:>4s} -> [{formatted}]")`,
        execution_count: null,
        outputs: [],
      },
      {
        id: uid('cell'),
        cell_type: 'code',
        source: `# Weighted Value output vectors
out = [
    [round(sum(w[j] * V[j][d] for j in range(len(V))), 4) for d in range(len(V[0]))]
    for w in weights
]
out`,
        execution_count: null,
        outputs: [],
      },
    ],
  };
}

function createDataExplorationLab(): NotebookData {
  const now = Date.now();
  return {
    id: uid('nb'),
    title: 'Data Exploration & Summary Lab',
    kernelName: 'Python 3',
    createdAt: now,
    updatedAt: now,
    cells: [
      {
        id: uid('cell'),
        cell_type: 'markdown',
        source: `# Exploratory Data Analysis

Run the cell below and check the **Variables** tab in the left sidebar to inspect every live object, shape, and preview in memory.`,
      },
      {
        id: uid('cell'),
        cell_type: 'code',
        source: `import statistics

latencies_ms = [12.4, 14.1, 11.8, 15.2, 13.7, 42.9, 12.9, 13.5, 14.8, 12.1]
summary = {
    "count": len(latencies_ms),
    "mean_ms": round(statistics.mean(latencies_ms), 2),
    "median_ms": round(statistics.median(latencies_ms), 2),
    "stdev_ms": round(statistics.stdev(latencies_ms), 2),
    "max_ms": max(latencies_ms),
}
summary`,
        execution_count: null,
        outputs: [],
      },
    ],
  };
}

export function createNotebookFromTemplate(templateId: NotebookTemplateId): NotebookData {
  switch (templateId) {
    case 'grad':
      return createGradientDescentLab();
    case 'attention':
      return createAttentionLab();
    case 'data':
      return createDataExplorationLab();
    case 'blank':
    default:
      return createBlankNotebook();
  }
}
