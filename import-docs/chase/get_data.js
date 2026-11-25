function getAllKeyPaths(jsonString) {
    const obj = JSON.parse(jsonString);
    const paths = [];

    function traverse(value, path) {
        if (value && typeof value === "object") {
            for (const key of Object.keys(value)) {
                const newPath = `${path}.${key}`;
                paths.push(newPath);
                traverse(value[key], newPath);
            }
        }
    }

    traverse(obj, "$");
    return paths;
}

const fs = require('fs');
fs.writeFileSync('out.json', JSON.stringify(val, null, 2), 'utf8');
