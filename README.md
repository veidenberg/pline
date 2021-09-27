<p align="center">
  <img width="570" alt="Pline header" src="https://user-images.githubusercontent.com/1215700/74085678-457a4180-4a84-11ea-84ac-be8dd2150465.png">
</p>

# Pline

[Documentation ⇢](http://wasabiapp.org/pline)  
[Demo site ⇢](http://wasabiapp.org/pline-demo)

**JSON-based web interfaces for command-line programs**

Pline is a specification for describing command-line programs and their interfaces, and its implementation as a lightweight web app. Pline renders web interfaces from JSON-formatted interface descriptions in `plugin.json` files. Custom interfaces can be written using the [plugin API](http://wasabiapp.org/pline/guide/api.html) and distributed e.g. by publishing the JSON files to the [plugins repository](https://github.com/veidenberg/pline-plugins). Pline was originally designed for the bioinformatics community, but the API is domain-agnostic, so a graphical interface can be crafted for any command-line executable.
Documentation, downloads and example interfaces are available on the [Pline website](http://wasabiapp.org/pline).

## Installation

1) Clone or download this repository
2) Add interfaces from the [plugins repository](https://github.com/veidenberg/pline-plugins)

## Usage

1) Launch Pline server: `python /path/to/Pline/pline_server.py`
2) Point a web browser to http://localhost:8000
3) Select an interface from the **Tools** menu
4) Fill the inputs and click **RUN** to launch the tool
5) The input/output and log files are accessible in the analyses folder (by default `/path/to/Pline/analyses/`)
