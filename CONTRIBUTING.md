# Development Guidelines

Lexcube for Jupyter has been released in January 2024 and is currently in **beta**. If you experience any issues or crashes, miss a feature or want to give any feedback, [opening an issue](https://github.com/msoechting/lexcube/issues/new/choose) is highly appreciated. Thank you.

## Development Installation

Create a dev environment:

```bash
# Using VENV only (if Node and Python are already installed)
npm i
python -m venv .venv
.\\.venv\\Scripts\\activate # or your OS-equivalent
pip install jupyterlab
pip install -r ./lexcube/lexcube_server/requirements-core.txt

# Using conda
conda create -n lexcube-dev -c conda-forge nodejs yarn python jupyterlab
python -m venv .venv
pip install -r ./lexcube/lexcube_server/requirements-core.txt
conda activate lexcube-dev
```

Install the python. This will also build the TS package.
```bash
pip install -e ".[test, examples]"
```

When developing your extensions, you need to manually enable your extensions with the
notebook / lab frontend. For lab, this is done by the command:

```bash
jupyter labextension develop --overwrite .
npm run build
```

For classic notebook, you need to run:

```bash
jupyter nbextension install --sys-prefix --symlink --overwrite --py lexcube
jupyter nbextension enable --sys-prefix --py lexcube
```

Note that the `--symlink` flag doesn't work on Windows, so you will here have to run
the `install` command every time that you rebuild your extension (or enable developer mode to enable symlinks). For certain installations you might also need another flag instead of `--sys-prefix`, but we won't cover the meaning of those flags here.

### How to see your changes
#### Typescript:
If you use JupyterLab to develop then you can watch the source directory and run JupyterLab at the same time in different
terminals to watch for changes in the extension's source and automatically rebuild the widget.

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
npm run watch
# Run JupyterLab in another terminal
jupyter lab
```

After a change wait for the build to finish and then refresh your browser and the changes should take effect.

#### Python:
If you make a change to the python code then you will need to restart the notebook kernel to have it take effect.

## Updating the version

To update the version, install tbump and use it to bump the version.
By default it will also create a tag.

```bash
pip install tbump
tbump <new-version>
```

## Publishing 
```bash
py -m pip install --upgrade build
py -m build
```
- Tip for Windows users: deactivate Windows Defender "real-time protection" to speed up builds and change your power plan if you are on a laptop.
- Make sure you have a clean working tree (including untracked files), since everything not ignored by the .gitignore will get packaged into the wheel.

See also: https://packaging.python.org/en/latest/tutorials/packaging-projects/