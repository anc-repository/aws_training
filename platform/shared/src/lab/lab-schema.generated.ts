// GENERATED from docs/platform/04-lab-format-checks-reports.md §3.3 (YAML block, parsed as YAML 1.2 core schema).
// Do not edit by hand: copy the YAML block again (see platform/shared/test/lab-schema.test.ts, which compares this object with the doc).
// labs/_schema/lab.schema.json is written from this object by `npm run labs:schema` (scripts/labs).

/** JSON Schema (draft 2020-12) of atl.lab/v2 — 04 §3.3, transcribed 1:1. */
export const LAB_SCHEMA_V2: Readonly<Record<string, unknown>> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:atl:schema:lab:v2",
  "title": "ATL lab.yaml v2（卡片）",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "kind",
    "version",
    "title",
    "summary",
    "difficulty",
    "estimatedMinutes",
    "timeLimitMinutes",
    "extensions",
    "retain",
    "services",
    "modules",
    "startProfile",
    "targetModules",
    "provision",
    "cost",
    "steps",
    "cleanup",
    "saa",
    "tags",
    "badge",
    "tracks"
  ],
  "properties": {
    "schema": {
      "const": "atl.lab/v2"
    },
    "id": {
      "$ref": "#/$defs/cardId"
    },
    "kind": {
      "enum": [
        "service",
        "scenario"
      ]
    },
    "service": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 3,
          "maxLength": 40
        },
        {
          "$ref": "#/$defs/l10n"
        }
      ]
    },
    "function": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 2,
          "maxLength": 20
        },
        {
          "$ref": "#/$defs/l10n"
        }
      ]
    },
    "version": {
      "$ref": "#/$defs/semver"
    },
    "status": {
      "enum": [
        "draft",
        "beta",
        "stable",
        "deprecated"
      ],
      "default": "draft"
    },
    "title": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 2,
          "maxLength": 48
        },
        {
          "$ref": "#/$defs/l10n"
        }
      ]
    },
    "subtitle": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 60
        },
        {
          "$ref": "#/$defs/l10n"
        }
      ]
    },
    "summary": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 10,
          "maxLength": 200
        },
        {
          "$ref": "#/$defs/l10n"
        }
      ]
    },
    "story": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 1200
        },
        {
          "$ref": "#/$defs/l10n"
        }
      ]
    },
    "scenario": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "question"
      ],
      "properties": {
        "question": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 20,
              "maxLength": 400
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "constraints": {
          "type": "array",
          "maxItems": 6,
          "items": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 80
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          }
        },
        "antiPatterns": {
          "type": "array",
          "maxItems": 6,
          "items": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 120
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          }
        }
      }
    },
    "objectives": {
      "type": "array",
      "maxItems": 6,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "text",
          "domain"
        ],
        "properties": {
          "text": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 80
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          },
          "domain": {
            "$ref": "#/$defs/saaDomain"
          },
          "relatesTo": {
            "$ref": "#/$defs/stepId"
          }
        }
      }
    },
    "difficulty": {
      "enum": [
        "intro",
        "beginner",
        "intermediate",
        "advanced"
      ]
    },
    "estimatedMinutes": {
      "type": "integer",
      "minimum": 15,
      "maximum": 480,
      "multipleOf": 15
    },
    "timeLimitMinutes": {
      "type": "integer",
      "minimum": 30,
      "maximum": 480,
      "multipleOf": 30
    },
    "extensions": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "maxCount",
        "minutesEach"
      ],
      "properties": {
        "maxCount": {
          "type": "integer",
          "minimum": 0,
          "maximum": 5
        },
        "minutesEach": {
          "type": "integer",
          "minimum": 10,
          "maximum": 120
        }
      }
    },
    "retain": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "allowed"
      ],
      "properties": {
        "allowed": {
          "type": "boolean"
        },
        "maxHours": {
          "type": "integer",
          "minimum": 1,
          "maximum": 72
        },
        "reason": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 120
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        }
      }
    },
    "regions": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "supported": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/region"
          }
        },
        "alsoUses": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "global",
              "us-east-1"
            ]
          }
        },
        "extra": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "const": "dr-region"
          }
        }
      }
    },
    "services": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "role"
        ],
        "properties": {
          "id": {
            "$ref": "#/$defs/serviceId"
          },
          "name": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 60
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          },
          "role": {
            "enum": [
              "primary",
              "supporting",
              "observed",
              "context"
            ]
          },
          "module": {
            "$ref": "#/$defs/moduleId"
          },
          "featureOf": {
            "$ref": "#/$defs/serviceId"
          },
          "optional": {
            "type": "boolean",
            "default": false
          },
          "creditBy": {
            "type": "array",
            "uniqueItems": true,
            "items": {
              "$ref": "#/$defs/stepId"
            }
          }
        }
      }
    },
    "modules": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "target",
        "start"
      ],
      "properties": {
        "target": {
          "$ref": "#/$defs/moduleList"
        },
        "start": {
          "$ref": "#/$defs/moduleList"
        },
        "context": {
          "$ref": "#/$defs/moduleList"
        },
        "related": {
          "$ref": "#/$defs/moduleList"
        }
      }
    },
    "prerequisites": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "cards": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "kind"
            ],
            "properties": {
              "id": {
                "$ref": "#/$defs/cardId"
              },
              "kind": {
                "enum": [
                  "soft",
                  "hard"
                ]
              }
            }
          }
        },
        "learnerInputs": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "enum": [
                  "domain",
                  "hosted-zone",
                  "ses-identity",
                  "notify-email",
                  "recipient-emails",
                  "alert-email",
                  "budget-amounts",
                  "cost-tags-active"
                ]
              },
              "required": {
                "type": "boolean",
                "default": true
              }
            }
          }
        },
        "knowledge": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 60
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          }
        }
      }
    },
    "startProfile": {
      "$ref": "#/$defs/startProfile"
    },
    "targetModules": {
      "type": "array",
      "maxItems": 6,
      "items": {
        "$ref": "#/$defs/targetModule"
      }
    },
    "expectedWarnings": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "$ref": "#/$defs/ruleId"
      }
    },
    "acceptedDrift": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]*\\.[A-Za-z][A-Za-z0-9]*\\.[A-Za-z][A-Za-z0-9.]*$"
      }
    },
    "workstation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "required": {
          "type": "boolean",
          "default": true
        },
        "sshFromWorkstation": {
          "type": "boolean",
          "default": false
        },
        "savingsMode": {
          "enum": [
            "ok",
            "degraded",
            "unsupported"
          ],
          "default": "ok"
        },
        "tools": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "aws-cli",
              "node",
              "k6",
              "git",
              "jq",
              "psql",
              "redis-cli",
              "session-manager-plugin"
            ]
          }
        }
      }
    },
    "platform": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "consoleLinks": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-z0-9]+\\.[A-Za-z0-9]+$"
          }
        },
        "accountImpact": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "scope",
              "resource",
              "revert"
            ],
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9-]{1,39}$"
              },
              "scope": {
                "enum": [
                  "account",
                  "region"
                ]
              },
              "resource": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 80
                  },
                  {
                    "$ref": "#/$defs/l10n"
                  }
                ]
              },
              "preexisting": {
                "enum": [
                  "adopt-readonly",
                  "not-applicable"
                ],
                "default": "not-applicable"
              },
              "revert": {
                "enum": [
                  "delete",
                  "restore",
                  "keep",
                  "manual"
                ]
              },
              "note": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 200
                  },
                  {
                    "$ref": "#/$defs/l10n"
                  }
                ]
              }
            }
          }
        }
      }
    },
    "variables": {
      "type": "object",
      "propertyNames": {
        "pattern": "^[a-z][A-Za-z0-9]{1,31}$"
      },
      "additionalProperties": {
        "$ref": "#/$defs/variable"
      }
    },
    "cost": {
      "$ref": "#/$defs/cost"
    },
    "provision": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "class"
      ],
      "properties": {
        "class": {
          "enum": [
            "A",
            "B",
            "C",
            "D"
          ]
        },
        "budgetMinutes": {
          "type": "integer",
          "minimum": 5,
          "maximum": 120
        },
        "cleanupBudgetMinutes": {
          "type": "integer",
          "minimum": 5,
          "maximum": 180
        }
      }
    },
    "steps": {
      "type": "array",
      "minItems": 1,
      "maxItems": 30,
      "items": {
        "$ref": "#/$defs/step"
      }
    },
    "finalChecks": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/checkRef"
      }
    },
    "experiments": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/experiment"
      }
    },
    "quiz": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "file"
      ],
      "properties": {
        "file": {
          "const": "quiz.yaml"
        },
        "draw": {
          "type": "integer",
          "minimum": 1,
          "maximum": 30
        }
      }
    },
    "badge": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "title"
      ],
      "properties": {
        "title": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 2,
              "maxLength": 8
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "short": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 6
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "icon": {
          "type": "string",
          "pattern": "^assets/[a-z0-9-]+\\.svg$"
        }
      }
    },
    "tracks": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "$ref": "#/$defs/trackId"
      }
    },
    "cleanup": {
      "$ref": "#/$defs/cleanup"
    },
    "saa": {
      "$ref": "#/$defs/saa"
    },
    "tags": {
      "type": "array",
      "minItems": 1,
      "maxItems": 12,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9-]{0,23}$"
      }
    },
    "permissions": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "learner": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-z0-9-]+:[A-Za-z0-9*]+$"
          }
        },
        "notes": {
          "type": "string"
        }
      }
    },
    "platformOps": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "op",
          "module",
          "title"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,39}$"
          },
          "op": {
            "enum": [
              "enable",
              "disable"
            ]
          },
          "module": {
            "$ref": "#/$defs/moduleId"
          },
          "args": {
            "type": "object",
            "additionalProperties": {
              "type": [
                "string",
                "number",
                "boolean"
              ]
            }
          },
          "title": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 40
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          },
          "confirm": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 200
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          },
          "optional": {
            "type": "boolean",
            "default": false
          },
          "interruptsManagementChannel": {
            "type": "boolean",
            "default": false
          }
        }
      }
    },
    "keepablePrerequisites": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "enum": [
          "route53-hosted-zone",
          "ses-identity",
          "acm-certificate"
        ]
      }
    },
    "extraStacks": {
      "type": "array",
      "maxItems": 4,
      "items": {
        "$ref": "#/$defs/extraStack"
      }
    },
    "certificate": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "enabled": {
          "type": "boolean",
          "default": false
        },
        "title": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 40
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "maxManualChecks": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "owners": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "allOf": [
    {
      "if": {
        "required": [
          "kind"
        ],
        "properties": {
          "kind": {
            "const": "service"
          }
        }
      },
      "then": {
        "required": [
          "service",
          "function"
        ],
        "properties": {
          "id": {
            "pattern": "^svc-"
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "kind"
        ],
        "properties": {
          "kind": {
            "const": "scenario"
          }
        }
      },
      "then": {
        "required": [
          "scenario",
          "story"
        ],
        "properties": {
          "id": {
            "pattern": "^sc-"
          },
          "difficulty": {
            "enum": [
              "intermediate",
              "advanced"
            ]
          }
        }
      }
    }
  ],
  "$defs": {
    "l10n": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "zh-CN"
      ],
      "properties": {
        "zh-CN": {
          "type": "string",
          "minLength": 1
        },
        "ja": {
          "type": "string",
          "minLength": 1
        },
        "en": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "text": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "$ref": "#/$defs/l10n"
        }
      ]
    },
    "cardId": {
      "type": "string",
      "pattern": "^(svc|sc)-[a-z0-9]+(-[a-z0-9]+)*$",
      "maxLength": 28
    },
    "trackId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,31}$"
    },
    "stepId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,39}$"
    },
    "checkId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,47}$"
    },
    "checkKey": {
      "type": "string",
      "pattern": "^(svc|sc)-[a-z0-9-]+/[a-z][a-z0-9-]{1,47}$"
    },
    "moduleId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,23}$"
    },
    "moduleList": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "$ref": "#/$defs/moduleId"
      }
    },
    "serviceId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,31}$"
    },
    "ruleId": {
      "type": "string",
      "pattern": "^[A-Z]{2,5}-[0-9]{3}$"
    },
    "labelId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,23}$"
    },
    "envKey": {
      "type": "string",
      "pattern": "^[A-Z][A-Z0-9_]{1,47}$"
    },
    "semver": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$"
    },
    "region": {
      "type": "string",
      "pattern": "^[a-z]{2}(-[a-z]+)+-[0-9]$"
    },
    "saaDomain": {
      "enum": [
        "secure",
        "resilient",
        "performance",
        "cost"
      ]
    },
    "guideRef": {
      "type": "string",
      "pattern": "^guide:[a-z][a-z0-9-]*#[a-z][a-z0-9-]*(/[A-Za-z0-9.\\-]+)*$"
    },
    "expr": {
      "type": "string",
      "maxLength": 200
    },
    "scalar": {
      "type": [
        "string",
        "number",
        "boolean"
      ]
    },
    "envMap": {
      "type": "object",
      "propertyNames": {
        "$ref": "#/$defs/envKey"
      },
      "additionalProperties": {
        "$ref": "#/$defs/scalar"
      }
    },
    "paramMap": {
      "type": "object",
      "propertyNames": {
        "pattern": "^[A-Za-z][A-Za-z0-9]{1,63}$"
      },
      "additionalProperties": {
        "$ref": "#/$defs/scalar"
      }
    },
    "provisionItem": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "item",
        "kind",
        "reason"
      ],
      "properties": {
        "item": {
          "type": "string",
          "pattern": "^[A-Za-z][A-Za-z0-9._-]{1,63}$"
        },
        "kind": {
          "enum": [
            "module",
            "local",
            "runtime",
            "seed",
            "platform"
          ]
        },
        "basis": {
          "enum": [
            "credential",
            "closure",
            "precursor",
            "context"
          ]
        },
        "set": {
          "$ref": "#/$defs/envMap"
        },
        "params": {
          "$ref": "#/$defs/paramMap"
        },
        "value": {
          "$ref": "#/$defs/scalar"
        },
        "rule": {
          "oneOf": [
            {
              "$ref": "#/$defs/ruleId"
            },
            {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/ruleId"
              }
            }
          ]
        },
        "contextKind": {
          "enum": [
            "https-entry",
            "protected-data",
            "shorten-wait",
            "realism"
          ]
        },
        "reason": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 4,
              "maxLength": 240
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "module"
              }
            }
          },
          "then": {
            "required": [
              "basis"
            ],
            "properties": {
              "item": {
                "$ref": "#/$defs/moduleId"
              }
            }
          },
          "else": {
            "not": {
              "required": [
                "basis"
              ]
            }
          }
        },
        {
          "if": {
            "required": [
              "basis"
            ],
            "properties": {
              "basis": {
                "const": "closure"
              }
            }
          },
          "then": {
            "required": [
              "rule"
            ]
          }
        },
        {
          "if": {
            "required": [
              "basis"
            ],
            "properties": {
              "basis": {
                "const": "context"
              }
            }
          },
          "then": {
            "required": [
              "contextKind"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "local"
              }
            }
          },
          "then": {
            "required": [
              "set"
            ],
            "properties": {
              "item": {
                "$ref": "#/$defs/moduleId"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "runtime"
              }
            }
          },
          "then": {
            "required": [
              "value"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                "const": "platform"
              }
            }
          },
          "then": {
            "properties": {
              "item": {
                "enum": [
                  "mgmt-channel",
                  "workstation",
                  "preview-direct-https",
                  "ssh-from-workstation",
                  "check-bundle"
                ]
              }
            }
          }
        }
      ]
    },
    "platformStart": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "preview"
      ],
      "properties": {
        "preview": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "directHttps"
          ],
          "properties": {
            "directHttps": {
              "enum": [
                "on",
                "off"
              ]
            }
          }
        }
      }
    },
    "branches": {
      "type": "object",
      "propertyNames": {
        "$ref": "#/$defs/ruleId"
      },
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "choose",
          "reason"
        ],
        "properties": {
          "choose": {
            "$ref": "#/$defs/moduleId"
          },
          "reason": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 200
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          }
        }
      }
    },
    "startProfile": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "provisions",
        "platform",
        "reason"
      ],
      "properties": {
        "base": {
          "const": "l0-ec2",
          "default": "l0-ec2"
        },
        "provisions": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/provisionItem"
          }
        },
        "branches": {
          "$ref": "#/$defs/branches"
        },
        "platform": {
          "$ref": "#/$defs/platformStart"
        },
        "variants": {
          "type": "array",
          "maxItems": 3,
          "items": {
            "$ref": "#/$defs/startVariant"
          }
        },
        "reason": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 400
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        }
      }
    },
    "startVariant": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "title",
        "select",
        "provisions",
        "reason"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,23}$",
          "not": {
            "const": "default"
          }
        },
        "title": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 40
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "select": {
          "enum": [
            "learner",
            "preflight"
          ]
        },
        "when": {
          "$ref": "#/$defs/expr"
        },
        "provisions": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/provisionItem"
          }
        },
        "branches": {
          "$ref": "#/$defs/branches"
        },
        "platform": {
          "$ref": "#/$defs/platformStart"
        },
        "targetModules": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/targetModule"
          }
        },
        "reason": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 240
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        }
      },
      "if": {
        "properties": {
          "select": {
            "const": "preflight"
          }
        }
      },
      "then": {
        "required": [
          "when"
        ]
      }
    },
    "targetModule": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "driver",
        "wireStep"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/moduleId"
        },
        "driver": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,31}$"
        },
        "fromDriver": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,31}$"
        },
        "set": {
          "$ref": "#/$defs/envMap"
        },
        "params": {
          "$ref": "#/$defs/paramMap"
        },
        "wireStep": {
          "$ref": "#/$defs/stepId"
        },
        "adoptsExisting": {
          "type": "boolean",
          "default": false
        },
        "optional": {
          "type": "boolean",
          "default": false
        }
      }
    },
    "variable": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "label",
        "from"
      ],
      "properties": {
        "label": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 24
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "from": {
          "enum": [
            "input",
            "derived"
          ]
        },
        "fillFrom": {
          "type": "string",
          "maxLength": 120
        },
        "pattern": {
          "type": "string",
          "maxLength": 200
        },
        "example": {
          "type": "string"
        },
        "help": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 200
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        }
      },
      "if": {
        "properties": {
          "from": {
            "const": "input"
          }
        }
      },
      "then": {
        "required": [
          "pattern"
        ]
      },
      "else": {
        "required": [
          "fillFrom"
        ]
      }
    },
    "cost": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "tier",
        "basis"
      ],
      "properties": {
        "currency": {
          "const": "USD"
        },
        "tier": {
          "enum": [
            "low",
            "medium",
            "high"
          ]
        },
        "tierWithOptional": {
          "enum": [
            "low",
            "medium",
            "high"
          ]
        },
        "mainDrivers": {
          "type": "array",
          "maxItems": 6,
          "items": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 40
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          }
        },
        "basis": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/costItem"
          }
        },
        "assumptions": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 200
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          }
        }
      }
    },
    "costItem": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "enum": [
                "start-profile",
                "workstation",
                "target-modules",
                "extra-stacks"
              ]
            },
            "note": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "$ref": "#/$defs/l10n"
                }
              ]
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "key",
            "pricingKey",
            "billing",
            "quantity",
            "source"
          ],
          "properties": {
            "key": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{1,31}$"
            },
            "pricingKey": {
              "type": "string",
              "pattern": "^[a-z0-9-]+(\\.[a-z0-9-]+)+$"
            },
            "billing": {
              "enum": [
                "hourly",
                "monthly",
                "usage",
                "one-time"
              ]
            },
            "quantity": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "unit": {
              "type": "string",
              "maxLength": 16
            },
            "assumedUsagePerHour": {
              "type": "number",
              "minimum": 0
            },
            "source": {
              "enum": [
                "start-profile",
                "workstation",
                "target",
                "learner-created",
                "extra-stack",
                "platform"
              ]
            },
            "optional": {
              "type": "boolean",
              "default": false
            },
            "whenRetained": {
              "type": "boolean",
              "default": true
            },
            "note": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 200
                },
                {
                  "$ref": "#/$defs/l10n"
                }
              ]
            }
          },
          "allOf": [
            {
              "if": {
                "properties": {
                  "billing": {
                    "const": "usage"
                  }
                }
              },
              "then": {
                "required": [
                  "assumedUsagePerHour",
                  "unit"
                ]
              }
            }
          ]
        }
      ]
    },
    "step": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "type",
        "title",
        "manual",
        "checks"
      ],
      "properties": {
        "id": {
          "$ref": "#/$defs/stepId"
        },
        "type": {
          "enum": [
            "console",
            "cli",
            "script",
            "code",
            "observe",
            "experiment"
          ]
        },
        "title": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 60
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "manual": {
          "type": "string",
          "pattern": "^manual/[0-9]{2}-[a-z0-9-]+\\.md$"
        },
        "from": {
          "$ref": "#/$defs/guideRef"
        },
        "wire": {
          "type": "boolean",
          "default": false
        },
        "optional": {
          "oneOf": [
            {
              "type": "boolean"
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "reason"
              ],
              "properties": {
                "reason": {
                  "anyOf": [
                    {
                      "type": "string",
                      "maxLength": 120
                    },
                    {
                      "$ref": "#/$defs/l10n"
                    }
                  ]
                },
                "when": {
                  "$ref": "#/$defs/expr"
                }
              }
            }
          ]
        },
        "when": {
          "$ref": "#/$defs/expr"
        },
        "requires": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "steps": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/stepId"
              }
            },
            "runtime": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/moduleId"
              }
            }
          }
        },
        "supersedes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/stepId"
          }
        },
        "estMinutes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 120
        },
        "methods": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "console",
              "cli",
              "script",
              "code"
            ]
          }
        },
        "panel": {
          "enum": [
            "terminal-lab",
            "terminal-workstation",
            "console",
            "preview"
          ]
        },
        "startsBilling": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "class",
            "pricingKeys"
          ],
          "properties": {
            "class": {
              "enum": [
                "hourly",
                "usage",
                "fixed-monthly"
              ]
            },
            "pricingKeys": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "note": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "$ref": "#/$defs/l10n"
                }
              ]
            }
          }
        },
        "wait": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "typicalMinutes",
            "maxMinutes"
          ],
          "properties": {
            "typicalMinutes": {
              "type": "integer",
              "minimum": 1
            },
            "maxMinutes": {
              "type": "integer",
              "minimum": 1,
              "maximum": 60
            },
            "text": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 120
                },
                {
                  "$ref": "#/$defs/l10n"
                }
              ]
            }
          }
        },
        "expectedOutage": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "channel",
            "maxMinutes",
            "reason"
          ],
          "properties": {
            "channel": {
              "enum": [
                "lab",
                "workstation",
                "both"
              ]
            },
            "maxMinutes": {
              "type": "integer",
              "minimum": 1,
              "maximum": 30
            },
            "reason": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 120
                },
                {
                  "$ref": "#/$defs/l10n"
                }
              ]
            }
          }
        },
        "checks": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/checkRef"
          }
        },
        "experiment": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "module",
            "id",
            "label"
          ],
          "properties": {
            "module": {
              "$ref": "#/$defs/moduleId"
            },
            "id": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{1,31}$"
            },
            "label": {
              "$ref": "#/$defs/labelId"
            }
          }
        },
        "pitfalls": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "required": [
                  "ref"
                ],
                "properties": {
                  "ref": {
                    "$ref": "#/$defs/guideRef"
                  }
                }
              },
              {
                "type": "object",
                "required": [
                  "id",
                  "symptom",
                  "match",
                  "cause",
                  "fix"
                ]
              }
            ]
          }
        },
        "saa": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "const": "experiment"
              }
            }
          },
          "then": {
            "required": [
              "experiment"
            ]
          }
        },
        {
          "if": {
            "required": [
              "wire"
            ],
            "properties": {
              "wire": {
                "const": true
              }
            }
          },
          "then": {
            "properties": {
              "type": {
                "enum": [
                  "script",
                  "cli",
                  "console"
                ]
              }
            }
          }
        }
      ]
    },
    "checkRef": {
      "oneOf": [
        {
          "$ref": "#/$defs/checkId"
        },
        {
          "$ref": "#/$defs/checkKey"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "oneOf": [
                {
                  "$ref": "#/$defs/guideRef"
                },
                {
                  "$ref": "#/$defs/checkId"
                },
                {
                  "$ref": "#/$defs/checkKey"
                }
              ]
            },
            "as": {
              "$ref": "#/$defs/checkId"
            },
            "required": {
              "type": "boolean"
            },
            "when": {
              "$ref": "#/$defs/expr"
            },
            "timeoutMs": {
              "type": "integer",
              "minimum": 1000,
              "maximum": 90000
            },
            "expectedWarnings": {
              "type": "array",
              "uniqueItems": true,
              "items": {
                "$ref": "#/$defs/ruleId"
              }
            },
            "drift": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "policy": {
                  "enum": [
                    "must-hold",
                    "once"
                  ]
                },
                "monitor": {
                  "type": "boolean"
                }
              }
            }
          }
        }
      ]
    },
    "experimentLabel": {
      "oneOf": [
        {
          "enum": [
            "before",
            "after",
            "run"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "role"
          ],
          "properties": {
            "id": {
              "$ref": "#/$defs/labelId"
            },
            "role": {
              "enum": [
                "baseline",
                "treatment",
                "single"
              ]
            },
            "title": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 24
                },
                {
                  "$ref": "#/$defs/l10n"
                }
              ]
            },
            "requires": {
              "type": "object",
              "propertyNames": {
                "$ref": "#/$defs/moduleId"
              },
              "additionalProperties": {
                "type": "string"
              }
            }
          }
        }
      ]
    },
    "experiment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "module",
        "id",
        "labels",
        "required"
      ],
      "properties": {
        "module": {
          "$ref": "#/$defs/moduleId"
        },
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,31}$"
        },
        "labels": {
          "type": "array",
          "minItems": 1,
          "maxItems": 6,
          "items": {
            "$ref": "#/$defs/experimentLabel"
          }
        },
        "pairs": {
          "type": "array",
          "items": {
            "type": "array",
            "minItems": 2,
            "maxItems": 2,
            "items": {
              "$ref": "#/$defs/labelId"
            }
          }
        },
        "requiredLabels": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/labelId"
          }
        },
        "required": {
          "type": "boolean"
        },
        "runner": {
          "enum": [
            "workstation",
            "browser"
          ],
          "default": "workstation"
        },
        "allowSimulatedBaseline": {
          "type": "boolean",
          "default": true
        },
        "validity": {
          "enum": [
            "traffic",
            "functional"
          ],
          "default": "traffic"
        },
        "corroborateWith": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/checkId"
          }
        },
        "compareAcross": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "enum": [
              "instanceType",
              "arch"
            ]
          }
        },
        "scenarios": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "corroboration": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "minServerRatio": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.9
            }
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "required": {
                "const": true
              }
            }
          },
          "then": {
            "properties": {
              "runner": {
                "const": "workstation"
              }
            }
          }
        },
        {
          "if": {
            "required": [
              "validity"
            ],
            "properties": {
              "validity": {
                "const": "functional"
              }
            }
          },
          "then": {
            "required": [
              "corroborateWith"
            ]
          }
        }
      ]
    },
    "extraStack": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "template",
        "region",
        "deploy",
        "reclaim"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,23}$"
        },
        "template": {
          "type": "string",
          "pattern": "^stacks/[a-z0-9-]+\\.ya?ml$"
        },
        "region": {
          "enum": [
            "app",
            "us-east-1",
            "dr-region"
          ]
        },
        "deploy": {
          "type": "string",
          "pattern": "^(start|step:[a-z][a-z0-9-]{1,39})$"
        },
        "when": {
          "$ref": "#/$defs/expr"
        },
        "optional": {
          "type": "boolean",
          "default": false
        },
        "params": {
          "type": "object",
          "propertyNames": {
            "pattern": "^[A-Za-z][A-Za-z0-9]{1,63}$"
          },
          "additionalProperties": {
            "type": "string",
            "maxLength": 200
          }
        },
        "outputs": {
          "type": "object",
          "propertyNames": {
            "pattern": "^[A-Za-z][A-Za-z0-9]{1,63}$"
          },
          "additionalProperties": {
            "type": "string",
            "pattern": "^var\\.[a-z][A-Za-z0-9]{1,31}$"
          }
        },
        "reclaim": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "phase"
          ],
          "properties": {
            "phase": {
              "enum": [
                "before-modules",
                "after-modules"
              ]
            },
            "notes": {
              "type": "string",
              "maxLength": 200
            }
          }
        }
      }
    },
    "cleanup": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "summary",
        "autoReclaim"
      ],
      "properties": {
        "summary": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 400
            },
            {
              "$ref": "#/$defs/l10n"
            }
          ]
        },
        "autoReclaim": {
          "const": true
        },
        "dataRisk": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "$ref": "#/$defs/l10n"
              }
            ]
          }
        },
        "learnerCreatedHints": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "resourceType",
              "how"
            ],
            "properties": {
              "resourceType": {
                "type": "string",
                "pattern": "^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$"
              },
              "how": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 200
                  },
                  {
                    "$ref": "#/$defs/l10n"
                  }
                ]
              }
            }
          }
        },
        "verify": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/checkRef"
          }
        }
      }
    },
    "saa": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "domains"
      ],
      "properties": {
        "domains": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/saaDomain"
          }
        },
        "topics": {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "ref"
                ],
                "properties": {
                  "ref": {
                    "$ref": "#/$defs/guideRef"
                  }
                }
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "id",
                  "title",
                  "domain"
                ],
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "title": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 60
                      },
                      {
                        "$ref": "#/$defs/l10n"
                      }
                    ]
                  },
                  "domain": {
                    "$ref": "#/$defs/saaDomain"
                  },
                  "relatesTo": {
                    "$ref": "#/$defs/stepId"
                  }
                }
              }
            ]
          }
        },
        "confusables": {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "required": [
                  "ref"
                ],
                "properties": {
                  "ref": {
                    "$ref": "#/$defs/guideRef"
                  }
                }
              },
              {
                "type": "object",
                "required": [
                  "a",
                  "b",
                  "rule"
                ],
                "properties": {
                  "a": {
                    "$ref": "#/$defs/text"
                  },
                  "b": {
                    "$ref": "#/$defs/text"
                  },
                  "rule": {
                    "$ref": "#/$defs/text"
                  }
                }
              }
            ]
          }
        }
      }
    }
  }
};
