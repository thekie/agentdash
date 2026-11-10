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

**Key**:
The optional set of columns that identify a row in a Data Store, such as the date in a weight log. Writing a row whose Key matches an existing row targets that row instead of adding a duplicate.
_Avoid_: id, primary key

**Projection**:
A Widget's declarative description of which Data Stores it reads and how it filters, joins, groups, and aggregates them into the slots the Widget draws. Running a Projection to read its rows is a **query**. The Projection is the description, and the query is the read.
_Avoid_: query, mapping, view

**Slot**:
A named input a Widget type draws, such as `x`, `y`, `value` or `target`. A Projection fills each Slot with a column.
_Avoid_: field, channel, binding

**Goal**:
A target that a progress Widget's value should reach, such as a goal weight of 80 kg or €10,000 saved. Reaching or passing it is good, whether the value gets there by rising or by falling.
_Avoid_: objective

**Limit**:
A target that a progress Widget's value should not cross, such as a monthly grocery budget or a minimum account balance. Crossing it is bad.
_Avoid_: cap, budget

**Archive**:
Removing a Dashboard, Widget, or Data Store from view without destroying it. Agents never delete permanently. Anything that is not Archived is **live**, so "the live Data Stores" are the ones not Archived.
_Avoid_: delete, trash

## Relationships

- A **Dashboard** holds ordered **Widgets** and ordered child **Dashboards**
- A **Widget** may hold ordered child **Widgets**
- A data **Widget** reads one or more **Data Stores** through its **Projection**; static Widgets hold their content inline
- Any **Agent** may change anything; there is no per-Agent ownership
- A progress **Widget**'s target is a **Goal** when the good direction leads from where progress starts toward the target, and a **Limit** otherwise
