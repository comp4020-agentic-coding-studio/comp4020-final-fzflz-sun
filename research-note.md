<!-- AGENT DRAFT, not the author's work yet. Drafted by Claude Code on
     1 November 2026 at the author's request, from sources the agent verified.
     The final-project brief advises drafting this note yourself; rewrite it
     in your own words and position before submission. Every claim about what
     you read or believe needs your confirmation. -->

# Verification is the practice: where agentic development should put its effort

Good agentic software development is not mainly about writing better prompts
or choosing a stronger model. It is about making the developer's checks
specific enough that an agent's claim of "done" can be tested by someone
other than the agent. The literature supports this more strongly than it
supports the common account that agents make developers faster.

## The productivity evidence points away from the model

The most cited early result is Peng et al.'s controlled experiment, in which
developers with GitHub Copilot implemented an HTTP server in JavaScript
55.8% faster than a control group (Peng et al., 2023). That is a real effect,
but on a small, self-contained task with a clear finish line.

METR's randomised trial reached the opposite result in a different setting.
Sixteen experienced open-source developers working on 246 real issues in
their own large repositories took 19% longer when allowed to use AI tools
(Becker et al., 2025). Before the study they expected a 24% speedup, and
afterwards still believed they had been 20% faster.

Read together, these studies do not show that AI helps or hurts. They show
that the value of an agent depends on how well the surrounding work defines
what correct means. A self-contained task carries its own definition of
done. A mature repository encodes correctness in conventions, history and
tacit knowledge the agent does not see, so the developer has to verify more
and the gain disappears. Most strikingly, developers misjudged the effect in
both directions, which means a developer's own sense of progress is not
reliable evidence.

## Benchmarks measure what checks can see

SWE-bench made this explicit by grading models on whether real GitHub issues
are resolved as judged by the project's own tests (Jimenez et al., 2024).
That design is the field's strength and its limit. A benchmark can only
reward what a test can detect; it says nothing about behaviour no test
covers. Agentic practice inherits the same limit: an agent optimising
against weak checks will satisfy the checks, not the intent.

## The practitioner response: simple loops, explicit checks

Practitioner guidance has converged on the same point from the other side.
Anthropic's engineering guidance recommends simple, composable patterns over
complex frameworks, transparency about the agent's plan, and careful design
of the tools an agent uses (Schluntz & Zhang, 2024). Its evaluator-optimizer
pattern, in which one step generates and another evaluates against explicit
criteria, is a design for exactly the gap METR exposed: separating the claim
of success from its verification.

## The counter-case

The strongest objection is that this is temporary. METR itself now marks its
result as a snapshot of early-2025 tools and reports that later tools likely
speed developers up more (Becker et al., 2025). If models become reliable
enough, heavy verification would be wasted effort.

That objection understates what verification is for. Better models reduce
how often a check fails, but they do not remove the need for someone to know
what correct means for this project, this user and this rule. The METR
perception gap is not a model weakness; it is a measurement weakness on the
human side, and stronger models make it more dangerous, because confident
wrong output becomes rarer and therefore less expected.

## Position

The direction worth defending is that agentic development should move effort
from generation to specification: written rules the agent is held to, checks
that test the claim rather than its name, and evidence the developer can
re-run. The productivity literature shows gains appear where correctness is
well defined; benchmarks show agents satisfy whatever checks exist; and
practitioner guidance already encodes that separation. The developer's
distinctive contribution is deciding what counts as correct.

## References

- Becker, J., Rush, N., Barnes, B., & Rein, D. (2025). *Measuring the impact
  of early-2025 AI on experienced open-source developer productivity.* METR.
  https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
  (paper: arXiv:2507.09089)
- Jimenez, C. E., Yang, J., Wettig, A., Yao, S., Pei, K., Press, O., &
  Narasimhan, K. (2024). SWE-bench: Can language models resolve real-world
  GitHub issues? *ICLR 2024.* https://openreview.net/forum?id=VTF8yNQM66
- Peng, S., Kalliamvakou, E., Cihon, P., & Demirer, M. (2023). *The impact of
  AI on developer productivity: Evidence from GitHub Copilot.*
  arXiv:2302.06590. https://arxiv.org/abs/2302.06590
- Schluntz, E., & Zhang, B. (2024, December 19). *Building effective agents.*
  Anthropic Engineering.
  https://www.anthropic.com/engineering/building-effective-agents
