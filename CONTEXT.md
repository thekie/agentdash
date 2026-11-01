# agentdash

A self-hosted dashboard whose content is written entirely by AI agents over MCP and read by one human in the browser.

## Language

**Owner**:
The single human who installs agentdash, connects agents to it, and reads the dashboards.
_Avoid_: user, admin

**Agent**:
An external AI client (Claude Code, Claude Desktop, any MCP client) connected to agentdash on the Owner's machine. Agents are the only writers and are not told apart: agentdash does not know which Agent made a change.
_Avoid_: bot, integration

### Structure

**Dashboard**:
A page of Widgets. Dashboards nest to any depth, so a "sub-dashboard" is just a Dashboard with a parent.
_Avoid_: page, board, view

**Area**:
A Dashboard with no parent, such as Finance or Health. It is the root of a Dashboard tree and can hold Widgets like any other Dashboard.
_Avoid_: workspace, project, space

**Widget**:
One visual block on a Dashboard, chosen from the Widget Catalog and configured by the Agent. Some Widgets only arrange other Widgets inside them.
_Avoid_: card, panel, component, block

**Widget Catalog**:
The fixed set of Widget types agentdash can render. Agents configure Widgets; they never supply rendering code.

### Data

**Data Store**:
A table of data whose columns an Agent defines and fills, such as a weight log or a monthly budget. A time series is a Data Store with a time column.
_Avoid_: series, dataset, collection

**Projection**:
A Widget's declarative description of which Data Stores it reads and how it filters, joins, groups, and aggregates them into the slots the Widget draws.
_Avoid_: query, mapping, view

**Slot**:
A named input a Widget type draws, such as `x`, `y`, `value` or `target`. A Projection fills each Slot with a column.
_Avoid_: field, channel, binding

**Archive**:
Removing a Dashboard, Widget, or Data Store from view without destroying it. Agents never delete permanently.
_Avoid_: delete, trash

## Relationships

- A **Dashboard** holds ordered **Widgets** and ordered child **Dashboards**
- A **Widget** may hold ordered child **Widgets**
- A data **Widget** reads one or more **Data Stores** through its **Projection**; static Widgets hold their content inline
- Any **Agent** may change anything; there is no per-Agent ownership
