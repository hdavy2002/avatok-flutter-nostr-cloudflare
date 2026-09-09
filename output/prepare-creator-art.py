import json, pathlib, subprocess, sys
root = pathlib.Path('/Users/davy/Documents/websites/avaTOK-2-Flutter')
manifest = json.loads((root/'output/creator-guide-art.json').read_text())
out = root/'web/public/assets/ideas/guides'
out.mkdir(parents=True, exist_ok=True)
selected = set(sys.argv[1:])
prepared = 0
for item in manifest:
    if selected and item['id'] not in selected:
        continue
    prepared += 1
    source = pathlib.Path(item['source'])
    full = out/(item['slug']+'.jpg')
    card = out/(item['slug']+'-card.jpg')
    if selected or not full.exists():
        subprocess.run(['sips','-s','format','jpeg','-s','formatOptions','82',str(source),'--out',str(full)],check=True,stdout=subprocess.DEVNULL)
    if selected or not card.exists():
        subprocess.run(['sips','-Z','768','-s','format','jpeg','-s','formatOptions','78',str(source),'--out',str(card)],check=True,stdout=subprocess.DEVNULL)
print(f'Prepared {prepared} unique illustrations with responsive card copies; originals preserved.')
