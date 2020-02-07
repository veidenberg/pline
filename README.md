# Pline

[Documentation ⇢](http://wasabiapp.org/pline/)  
[Demo site ⇢](http://wasabiapp.org/pline-demo/)

**JSON-based web interfaces for command-line programs**

Pline is a specification for describing command-line programs and their interfaces, and its implementation as a lightweight web app. Pline renders web interfaces from JSON-formatted interface descriptions in `plugin.json` files. Custom interfaces can be written using the plugin API and distributed e.g. by pusblishing `plugin.json` files to the [plugin repository]. Pline was originally designed for the bioinformatics community, but the plugin API is domain-agnostic, so a graphical interface can be crafted for any command-line executable.
Documentation, downloads and exampl einterfaces are available on the Pline website.

## Installation

1) Clone or download this repository
2) Add interfaces from the [plugins repository](https://github.com/veidenberg/plugins)

## Usage

1) Launch Pline server: `python path/to/Pline/pline_server.py`
2) Open a web browser an go to http://localhost:8000
3) Select an interface from the **Tools** menu
4) Fill the inputs and click **RUN** to launch the command-line tool
5) Collect the result files from the data folder (by default `path/to/Pline/analyses/`)